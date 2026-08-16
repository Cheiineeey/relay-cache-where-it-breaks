#!/usr/bin/env node
/**
 * relay-cache-check —— 中转站 prompt cache 体检
 *
 * 这不是重写，是从一个跑了两周的私人网关里**抠出来**的那段。
 * 每一条判据背后都是一次真踩过的雷，README 的 §8.3 列着它自己出过的 18 个 bug。
 *
 * 用法：
 *   node cache-check.js --url https://你的站/v1/messages --key sk-xxx --model 模型名
 *
 * 可选：
 *   --no-stream              只测非流式（默认两条都测）
 *   --thinking               请求里开扩展思考
 *   --endpoint-tools         标记为「端点清单」模式（只影响归档口径）
 *   --prefix-file <path>     用你自己的系统提示词当探针前缀（**强烈建议**，见 README §6）
 *   --usage-file <path>      真实用量样本（JSONL，每行 {in,cw,cr,model,url,ep,stream}）
 *   --fp-ring <path>         前缀指纹环（JSON 数组），没有就跳过这一块
 *   --json                   只输出 JSON，不打印人话报告
 *
 * 🔴 它会真的打模型、真的花钱。默认 8 发左右，几毛钱量级，跑完会报实际花了多少。
 * 🔴 它只发探针、只读回执，**不往你的系统里写任何东西**。
 *
 * MIT · Elle & Matt · https://github.com/Cheiineeey/relay-cache-where-it-breaks
 */
"use strict";

const fs = require("fs");

function argv(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith("--")) ? v : true;
}
const has = (name) => process.argv.includes("--" + name);

// `https://x/v1` / `https://x/v1/chat/completions` 都归一到 `/v1/messages`。
// 🔴 走 OpenAI 那个门（/chat/completions）会把 cache_control 静默吞掉 —— 见 README §1。
function _toMessagesEndpoint(u) {
  let s = String(u || "").trim();
  if (!s) return "";
  s = s.replace(/\/(chat\/completions|messages)\/?$/i, "");
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s + "/messages";
}

const HELP = `
relay-cache-check —— 中转站 prompt cache 体检

  node cache-check.js --url <站地址> --key <key> --model <模型标签> [选项]

必填
  --url <u>          站的地址。/v1、/v1/chat/completions、/v1/messages 都行，
                     内部一律归一到 /v1/messages（走 OpenAI 那个门会吞掉 cache_control）
  --key <k>          API key
  --model <m>        模型标签，照抄站子给的那一串（「次」/「量」会影响结论）

强烈建议
  --prefix-file <f>  拿你真实的系统提示词当探针前缀。不给就退回 8k 填充文字，
                     而「这个玩具能缓存」不等于「你六万八的负载能缓存」

可选
  --usage-file <f>   真实用量样本（JSONL，每行 {"in":..,"cw":..,"cr":..,"model":..,
                     "url":"host","ep":0,"stream":1}）。不给这一块会明说跳过了
  --fp-ring <f>      前缀指纹环（JSON 数组）。不给同样明说跳过
  --no-stream        只测非流式（默认两条都测）
  --no-thinking      请求里关掉扩展思考（**默认是开的** —— 开不开会改变行为：
                     Anthropic 不允许「强制调工具 + 扩展思考」同时成立）
  --endpoint-tools   标记为「端点清单」模式（只影响归档口径）
  --json             只输出 JSON
  --help             这一页

🔴 它会真的打模型、真的花钱（实测 $0.33～$0.42 / 8 发），跑完报实际花费。
🔴 它只发探针、只读回执，不往你的系统里写任何东西。
🔴 它自己出过 23 个 bug，形状写在主文档 §8.3 —— 看一眼再信它的数字。
`;

async function main() {
  const _url = _toMessagesEndpoint(argv("url", ""));
  const _key = String(argv("key", "")).trim();
  const _model = String(argv("model", "")).trim();
  // 🔴 `--help` 原来会走到下面那句「缺参数……看 --help」然后 exit 2 ——
  // **一个让你去看 --help 的报错，本身就是 --help 的输出。** 外部 review 抓到的。
  if (has("help") || has("h") || process.argv.length <= 2) { console.log(HELP); process.exit(0); }
  if (!_url || !_key || !_model) {
    console.error("缺 --url / --key / --model。\n");
    console.log(HELP);
    process.exit(2);
  }
  const _routeHost = String(_url).replace(/^https?:\/\//, "").split("/")[0];
  const _routeEp = has("endpoint-tools") ? 1 : 0;
  const _routeStream = has("no-stream") ? 0 : 1;
  const _wantThinking = !has("no-thinking");
  const _routeThinking = _wantThinking ? 1 : 0;
  const _prefixFile = argv("prefix-file", null);
  const _usageFile = argv("usage-file", null);
  const _fpRingFile = argv("fp-ring", null);

  // 站子自己的账单计数器 —— 比按牌价估准，而且不用知道这个通道打了几折。
  // 单位是**美分**（08-14 实测：5167 token 的缓存写入 = 4.39，命中同样 5167 = 0.38，
  // 差 11.5 倍，跟 Anthropic 缓存写 1.25x / 读 0.1x 的比例对得上）。
  // ⚠️ 这是**账号级**的计数器：体检期间如果她正在聊天、或者有主动推送，
  //    差值会被那些请求污染。所以给出来的钱是量级，不是发票。
  const _billBase = _url.split("/v1/")[0];
  async function _bill() {
    try {
      const r = await fetch(_billBase + "/v1/dashboard/billing/usage", {
        headers: { "Authorization": "Bearer " + _key }, signal: AbortSignal.timeout(20000)
      });
      if (!r.ok) return null;
      const j = await r.json();
      return typeof j.total_usage === "number" ? j.total_usage : null;
    } catch (_e) { return null; }
  }
  const _money = (c) => c == null ? null : "$" + (c / 100).toFixed(4);
  // 从 SSE 流 / JSON 正文里把「200 但其实是错」揪出来。两个信号：
  //   1. `{"type":"error"...}` 事件；2. id 长成 `msg_err_…`（站子给错误现编的）
  function _inlineError(raw) {
    // 🔴 **别假设 JSON 里字段的先后顺序。** 第一版写的是「先 type:error 再 message」，
    // 而 某站 那条正好反着来（`{"error":{"type":"overloaded_error","message":"…"},"type":"error"}`），
    // 于是提不出 "overloaded" 这个词，「过载」那句建议就永远不会触发。
    // 现在整块 `"error":{…}` 一起抓，里面的 type / message 各认各的。
    const _blk = String(raw).match(/"error"\s*:\s*\{([\s\S]{0,400}?)\}/);
    if (_blk) {
      const _t = _blk[1].match(/"type"\s*:\s*"([^"]{0,60})"/);
      const _msg = _blk[1].match(/"message"\s*:\s*"([^"]{0,160})"/);
      return `上游报错（${_t ? _t[1] : "error"}）：${_msg ? _msg[1] : _blk[1].slice(0, 120)}`;
    }
    if (/"id"\s*:\s*"msg_err_/.test(String(raw))) return "上游返回了一个 msg_err_ 开头的错误响应（八成是过载或限流）";
    return null;
  }
  // 🔴 账单是**异步入账**的，固定等 4 秒不够：08-14 第一次就把冷启那一发的钱
  // 漏到了下一格，界面上显示「没打中 $0.0000」—— 一个假的零比没有数字更糟。
  // 改成盯着它，等真的动了再走；到点还没动就老实返回 null（宁可不说）。
  // 🔴 08-15 又踩一次：原来这里「动了就走」，可账单是**分批入账**的 ——
  // 冷启那一发的钱只落了一部分就返回，剩下的落进下一格，于是「省 -575%」。
  // 改成**等它不动了再走**：先等它开始动，再连着两拍数字不变才认为结清。
  // 另外 prev==null 时原来第一拍就 return（`prev == null || _v > prev` 恒真），
  // 所谓「等结算」其实只是 sleep 1.5 秒 —— 体检总花费一直在少报。
  async function _billSettle(prev, ms = 25000) {
    const _t0 = Date.now();
    let _last = null, _still = 0, _moved = prev == null;
    while (Date.now() - _t0 < ms) {
      await new Promise(r => setTimeout(r, 1500));
      const _v = await _bill();
      if (_v == null) return null;
      if (!_moved) { if (_v > prev) { _moved = true; _last = _v; _still = 0; } continue; }
      if (_last != null && _v === _last) { if (++_still >= 2) return _v; }
      else { _last = _v; _still = 0; }
    }
    return _moved ? _last : null;
  }

  // 🔴 **一次体检要真打 5 发模型**（非流 2 + 流 2 + 工具 1）。
  // 08-14 她点了一下、账单上出现 10 条 —— 日志里是两轮，相隔 39.7 秒，都来自 app。
  // app 侧的 `.disabled(checking)` 挡不住（@State 一被重建就复位，在途的 Task 还活着）。
  // **闸要设在花钱的这一端**：同一个 模型+站，90 秒内重复请求直接返回上一次的结果，
  // 不再打模型；正在跑的那一轮就等它，别并发出第二轮。
  // 结果只能复用于同一把 key、同一条完整通道。否则切换 key / 流式 / 端点清单 / thinking
  // 后十分钟内再点，会拿到上一套配置的旧报告。
  let _shots = 0;
  const _stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  // 🔴🔴 **探针必须拿她真实那份前缀去打。**
  // 她 08-15："某站 探针打出来能缓存，我实际用不上，这是个 bug 吧，你的按钮误导我。"
  // **是 bug。** 原来撑前缀用的是我自己造的一万四千字填充文字，
  // 而她真实请求是六万八 + 几百条历史。探针那句「非流式命中 88%」
  // 对它自己那个玩具成立，对她的负载不成立 —— 她照着关了流式，结果更差。
  // 08-14 我修过一次这个坑，当时补的是探针的**形状**（加工具、加 thinking），
  // **没补它的体量**。现在直接读她真实的人格块 + 摘要块来当前缀。
  // 读不到才退回填充文字，并且在结果里说明这次用的是假前缀。
  // 🔴🔴 **探针必须拿你真实那份前缀去打。**
  // 原始版本里这里读的是作者自己的人格块 + 摘要（那是它跑在自己网关里的好处）。
  // 独立版没有那份数据 —— 所以**请用 `--prefix-file` 把你真实的系统提示词喂进来**。
  //
  // 不喂会怎样：退回填充文字，而填充文字只有 8k 左右。
  // 真实负载六万八的时候，「这个玩具能缓存」对你的负载不成立 ——
  // 这正是 README §2 §6 那一课，作者本人被自己的探针误导过一次。
  // 所以没喂前缀时，结果里会明写「这次用的是假前缀，别照着改开关」。
  let _realPrefix = null;
  if (_prefixFile) {
    try {
      const _t = fs.readFileSync(String(_prefixFile), "utf8");
      if (_t.length > 4000) _realPrefix = _t;
      else console.error(`⚠️ --prefix-file 只有 ${_t.length} 字符，太短了（<4000），按没给处理`);
    } catch (e) { console.error("⚠️ --prefix-file 读不到：" + e.message); }
  }

  const _salt = (tag) => `〖缓存体检一次性盐 ${_stamp}-${tag}〗这一行只在本次体检的本组出现，用来强制第一发冷启，不要理会它的内容。\n\n`;
  const _filler = (tag) => _salt(tag) + (_realPrefix
    ? `${_realPrefix}\n\n【本次体检标记 ${_stamp}-${tag}】`
    : `缓存体检探针 ${_stamp}-${tag}。这段文字只在这一次体检里出现，用来把前缀撑过最小可缓存长度。`.repeat(150));
  // 🔴 60 遍只有 ~3.5k token，**在 Opus 的最小可缓存长度以下**，
  // 会把「通道不缓存」和「前缀太短」测成同一个样子（08-14 当场踩到）。150 遍 ≈ 8k。

  async function _one(tag, stream) {
    // 🔴 **探针必须长得像真请求。**
    // 第一版只有一个 8k 的 system 块、没工具、没 thinking —— 于是它在她的通道上
    // 测出「非流式命中」，她照做关掉流式，真实那 44k + 84 个工具 + thinking 的请求
    // **cache_write=0 cache_read=0，而且思考链整个没了**。
    // 一个测不出真相的体检比没有体检更坏，因为她会照着它做决定。
    const _body = {
      model: _model, max_tokens: 16, stream,
      system: [{ type: "text", text: _filler(tag), cache_control: { type: "ephemeral" } }],
      tools: [
        { name: "her_heart", description: "看她此刻的心率。" + "（这段描述只是用来把工具块撑到真实体量）".repeat(40),
          input_schema: { type: "object", properties: { minutes: { type: "number" } } } },
        { name: "search_memories", description: "搜我们的记忆。" + "（同上，撑体量）".repeat(40),
          input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          cache_control: { type: "ephemeral" } }
      ],
      tool_choice: { type: "auto" },
      // 🔴 探针**默认开扩展思考**，因为开不开会改变行为（Anthropic 不允许
      // 「强制调工具 + 扩展思考」同时成立，见 README §8.2）。
      // 原来这里写死 enabled，而 `--thinking` 那个参数存进变量就再没用过 ——
      // 文档说"用 --thinking 打开"，其实它一直是开的。改成 `--no-thinking` 能真关掉。
      ...(_wantThinking ? { thinking: { type: "enabled", budget_tokens: 1024 } } : {}),
      messages: [{ role: "user", content: "说一个字：好" }]
    };
    if (_body.thinking) _body.max_tokens = 2048;
    const _t0 = Date.now();
    let _res;
    _shots++;
    try {
      _res = await fetch(_url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + _key, "x-api-key": _key,
                   "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31" },
        body: JSON.stringify(_body),
        signal: AbortSignal.timeout(120000)
      });
    } catch (e) { return { err: String(e).slice(0, 100) }; }
    const _raw = await _res.text();
    if (!_res.ok) return { err: `HTTP ${_res.status}: ${_raw.slice(0, 100)}` };
    // 🔴🔴 **HTTP 200 不等于成功。** 08-15 实测 某站 的 某按量通道：状态码 200、
    // `message_start` 照发、id 是它现编的 `msg_err_1786802608331`，后面跟着
    // `{"error":{"type":"overloaded_error"...}}` —— 站子只是过载了。
    // 把这一发当成有效测量，就会得出「这条不缓存 / 不会调工具 / 掺水」，**全是假的**。
    const _ie = _inlineError(_raw);
    if (_ie) return { err: _ie };
    let _u = null, _id = null, _think = false;
    if (stream) {
      for (const _l of _raw.split("\n")) {
        if (!_l.startsWith("data: ")) continue;
        try { const _o = JSON.parse(_l.slice(6));
          if (_o.type === "message_start") { _u = _o.message?.usage || null; _id = _o.message?.id || null; }
          if (_o.type === "content_block_start" && _o.content_block?.type === "thinking") _think = true;
        } catch (_e) {}
      }
    } else {
      try { const _o = JSON.parse(_raw); _u = _o.usage || null; _id = _o.id || null;
        // 🔴 08-15 她关掉流式之后：整段响应 226 字节、只有一个 text 块、没有 thinking，
        // 而 out=92 token 只吐出 6 个字 —— **思考链的钱照收，内容不给**。
        // 体检以前只测缓存，从没测过这一项，于是那个开关等于让她自己去踩。
        _think = Array.isArray(_o.content) && _o.content.some(b => b && b.type === "thinking");
      } catch (_e) { return { err: "响应不是 JSON: " + _raw.slice(0, 80) }; }
    }
    return { ms: Date.now() - _t0, id: _id, usage: _u, think: _think,
             in: _u?.input_tokens ?? null, w: _u?.cache_creation_input_tokens ?? null, r: _u?.cache_read_input_tokens ?? null };
  }

  async function _pair(tag, stream) {
    const _c0 = await _bill();
    const _a = await _one(tag, stream);
    // 🔴 **状态用布尔，别用文案** —— 同 08-14 那条「/强制/.test(_mode)」的教训。
    // 打不通必须让下面的建议逻辑判得出来，不然「没测成」会被当成「测出来没缓存」。
    if (_a.err) return { verdict: "打不通", unreachable: true, detail: _a.err };
    const _c1 = await _billSettle(_c0);
    const _b = await _one(tag, stream);
    if (_b.err) return { verdict: "打不通", unreachable: true, detail: _b.err };
    const _c2 = await _billSettle(_c1);
    const _hit = (_b.r || 0) > 0;
    // 🔴 瞎有两种长相：字段缺失（null），和**字段在但全是 0**。
    // 我们发的前缀 >8k，`in=0` 在物理上不可能是真的 —— 那是站子不给你看账，
    // 不是「没命中」。只认 null 的话，全零那种又会印出「没打中 0 token」。
    const _blind = (_b.r === null && _b.w === null) ||
                   ((_b.in || 0) === 0 && !(_b.w || 0) && !(_b.r || 0));
    // 🔴 第一发本该是冷的（w>0 r=0）。它要是 w=0 而 r>0，说明基线在开打之前就热了 ——
    // salt 之外还有路径把这段前缀写进过缓存，或者站子按它自己的口径匹配。
    // 那这一组的「没打中」是假的，分母脏了，**百分比一个字都不能印**。
    // 「没测成」是第三种结论，不是「打不中」的同义词（同 08-15 那三次的教训）。
    const _baseHot = !_blind && (_a.r || 0) > 0 && !(_a.w || 0);
    // 第一发 = 没打中缓存的那一发（冷）；第二发 = 打中的那一发（热）
    const _cold = (_c0 != null && _c1 != null) ? Math.max(0, _c1 - _c0) : null;
    const _hot  = (_c1 != null && _c2 != null) ? Math.max(0, _c2 - _c1) : null;
    // 🔴🔴 **08-15 她截图里的「省 -575%」就出在下面这个百分比上。**
    // 原来是拿账单差值算的（$0.0065 → $0.0437）。那个计数器是**账号级 + 异步分批入账**的：
    // 冷启那发的钱被劈成两半分给了两个格子，一除就是负五百多。
    // 她同时在聊天、有推送，也往同一个格子里加钱。**账单差值不能用来算比例。**
    // 改成按 token 折算 —— Anthropic 的口径是：普通 1x、缓存写 1.25x、缓存读 0.1x。
    // 折成「等价全价 token」再比，不依赖账单，也不用知道这条通道打几折。
    const _units = (x) => (x.in || 0) + (x.w || 0) * 1.25 + (x.r || 0) * 0.1;
    const _cu = _units(_a), _hu = _units(_b);
    // 🔴 瞎的时候 token 一律给 null，**不给 0**。
    // 「没打中 0 token」是个假的零 —— 假的零比没有数字更糟（08-14 自己写下的那句）。
    // 基线已经热的时候，「没打中」那一栏根本不是没打中 —— 它是又一个假的事实。
    // 宁可印「看不到」，也不能把一个命中的数字挂在「没打中」下面（同 08-15 那个假的零）。
    const _coldTok = (_blind || _baseHot) ? null : (_a.in || 0) + (_a.w || 0) + (_a.r || 0);
    const _hotTok  = _blind ? null : (_b.in || 0) + (_b.w || 0) + (_b.r || 0);
    const _savedTok = (!_blind && !_baseHot && _cu > 0) ? Math.round((1 - _hu / _cu) * 100) : null;
    const _savedBill = (!_baseHot && _cold != null && _hot != null && _cold > 0)
                       ? Math.round((1 - _hot / _cold) * 100) : null;
    // 两个口径差得离谱的时候直说，别让她以为哪个是错的 —— 是账单那个不可信
    const _savedNote = _baseHot
      ? "第一发就直接读到了缓存（w=0 r>0），这一组的「没打中」基线是假的 —— 能命中是真的，能省多少这次没测出来，不是打不中"
      : (_savedTok != null && _savedBill != null && Math.abs(_savedTok - _savedBill) >= 15)
      ? `按 token 折算是 ${_savedTok}%，按账单差值算是 ${_savedBill}% —— 以 token 为准，账单是账号级计数器，体检时你在聊天或有推送都会算进去`
      : null;
    return {
      verdict: _hit ? (_baseHot ? "命中（省多少没测成）" : "命中")
                    : (_blind ? "站子不返回缓存字段（瞎的）" : "没命中"),
      hit: _hit,
      blind: _blind,
      baseline_hot: _baseHot,
      cold_tokens: _coldTok, cold_cost: _baseHot ? null : _money(_cold),
      hot_tokens: _hotTok,  hot_cost: _money(_hot),
      hot_fresh: _blind ? null : (_b.in || 0), hot_cached: _blind ? null : (_b.r || 0),
      // 这条链路还给不给思考块（两发只要有一发给了就算给）
      thinking_back: !!(_a.think || _b.think),
      saved: _savedTok == null ? null : _savedTok + "%",
      saved_note: _savedNote,
      detail: `第一发 in=${_a.in} w=${_a.w} r=${_a.r} (${_a.ms}ms) ｜ 第二发 in=${_b.in} w=${_b.w} r=${_b.r} (${_b.ms}ms)`,
      backend: String(_b.id || "").startsWith("msg_01") ? "Anthropic 格式响应（仅凭 id 不能证明直连）" :
               String(_b.id || "").startsWith("req_vrtx") ? "Vertex 格式响应（仅凭 id 不能证明来源）" :
               String(_b.id || "").startsWith("chatcmpl") ? "被转成 OpenAI 协议（必丢 cache_control）" : String(_b.id || "?").slice(0, 16)
    };
  }

  // ── 会不会调工具 ────────────────────────────────────
  // 08-14 她："我现在用的那个模型居然不能调用工具。"查实：某按量通道那条
  // **开不开 thinking 都一个工具不调**，而且回来的 id 是 `msg_1fcd181671d24c93`
  // 这种十六进制 —— 真 Anthropic 是 `msg_01…`。名字挂着 claude，后面不是。
  // 缓存测得再准，模型是个哑巴也没用，所以并进体检一起报。
  async function _toolProbe() {
    // 🔴🔴 **08-14：她「探针说不能用工具，but 我刚刚聊天端调用成功了」。**
    // 上一版用 `tool_choice: {type:"auto"}` —— 那测的是**它愿不愿意调**，不是**能不能调**。
    // 只给一个工具、一句干巴巴的系统提示，模型完全可以选择直接开口回答，
    // 于是被我记成「不会调」。真实聊天里 84 个工具、完整人格、真问题，它当然调。
    // **测能力就要强制**：`tool_choice: {type:"any"}` = 这一轮必须调一个工具。
    // 有些中转站不认 `any`，那就退回 `auto` 再试一次，并在结果里说明用的哪种
    // —— 退回之后的「不会调」只能算「没选择调」，不能当成不能调。
    // 过载是一时的，为它下一个「换通道」的结论太亏了 —— 撞上就隔 3 秒再来一发
    async function _shotRetry(choice) {
      let _r = await _shot(choice);
      if (_r.ok && /overloaded|temporarily unavailable/i.test(_r.raw || "")) {
        await new Promise(r => setTimeout(r, 3000));
        _r = await _shot(choice);
      }
      return _r;
    }
    async function _shot(choice) {
      const _body = {
        model: _model, max_tokens: 1024, stream: true,
        system: [{ type: "text", text: "你是韩屿。需要用工具的时候直接用，别问。" }],
        tools: [{ name: "her_heart", description: "看她此刻的心率。",
                  input_schema: { type: "object", properties: { minutes: { type: "number" } } } }],
        tool_choice: choice,
        messages: [{ role: "user", content: "我心跳好快，你看一下我现在心率多少" }]
      };
      _shots++;
      const _r = await fetch(_url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + _key, "x-api-key": _key,
                   "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31" },
        body: JSON.stringify(_body), signal: AbortSignal.timeout(120000)
      });
      return { ok: _r.ok, status: _r.status, raw: await _r.text() };
    }
    try {
      // 🔴 **别拿给人看的话做程序判断。** 上一版用 `/强制/.test(_mode)` 判是不是强制模式，
      // 而退回那句写的是「自选（…这个站不认强制）」—— **里面就有「强制」两个字**，
      // 于是退回路径被判成强制路径，「这轮没调」又变回了「不会调」。
      // 她 08-14 当场撞到：体检说不会调，聊天端却调成功了。**状态用布尔，别用文案。**
      let _forcedOK = true;
      let _mode = "强制（tool_choice:any）";
      let _r = await _shotRetry({ type: "any" });
      if (!_r.ok) {
        _forcedOK = false;
        // 🔴 **归因要看它到底说了什么，别一律赖在站子头上。**
        // 08-15 实测：模型名里带 thinking 时中转站会自动开扩展思考，而 Anthropic
        // 本身就禁止「强制调工具 + 扩展思考」同时开 —— 报的是
        // `Thinking may not be enabled when tool_choice forces tool use`。
        // 上一版一律写成「这个站不接受强制调用」，我还拿它当过掺水的旁证，**是冤枉它的**。
        _mode = /thinking may not be enabled|tool_choice forces/i.test(String(_r.raw || ""))
          ? "自选（tool_choice:auto —— 这个模型开着扩展思考，Anthropic 不允许同时强制调工具，跟站子无关）"
          : "自选（tool_choice:auto，这个站不接受强制调用）";
        _r = await _shotRetry({ type: "auto" });
      }
      const _raw = _r.raw;
      if (!_r.ok) return { verdict: "打不通", detail: `HTTP ${_r.status}` };
      // 同 A：200 里夹带 error 的那种，**不能判成「不会调」，更不能判成「掺水」**。
      // 08-15 她那条 某按量通道 就是这么被我冤枉的：过载 → 没有 tool_use → 「不会调」→
      // id 不是正牌格式 → 「掺水」→ 建议她换通道。一条错的证据推出两条错的结论。
      const _tie = _inlineError(_raw);
      if (_tie) return { verdict: "打不通", detail: _tie, ok: null, watered: null,
                         genuine: "这一发上游报错了，血统认不出（不代表有问题）" };
      let _tool = null, _mid = null, _stop = null;
      for (const _l of _raw.split("\n")) {
        if (!_l.startsWith("data: ")) continue;
        try {
          const _o = JSON.parse(_l.slice(6));
          if (_o.type === "message_start") _mid = _o.message?.id;
          if (_o.type === "content_block_start" && _o.content_block?.type === "tool_use")
            _tool = { name: _o.content_block.name, id: _o.content_block.id };
          if (_o.type === "message_delta") _stop = _o.delta?.stop_reason;
        } catch (_e) {}
      }
      // 🔴 **掺没掺水，看 id 的前缀。** 这是 08-13 那次翻出来的一套判据，
      // 08-14 她问「能不能顺便测出模型掺水，比如你之前说的掺水 Gemini」——
      // id 只能说明响应采用了哪种格式，不能证明中转站后面实际接的 provider / 模型。
      // 只有 id 明确暴露 gemini / OpenAI 时才能报协议或模型不一致；其余老实说不知道。
      //   cpa_gemini_ / gemini = 🔴 挂着 claude 的名，后面是 Gemini
      //   chatcmpl-            = 回来的是 OpenAI 那套格式，说明中转站把请求换过一道；
      //                            **我们测到的那几条这样的链路上，cache_control 被吞了**（不敢说"必"）
      //   十六进制那种           = 只能说明不是 Anthropic 常见的 id 形状，**据此判断不了后面是谁**
      const _ids = (String(_mid || "") + " " + String(_tool?.id || "")).toLowerCase();
      let _water, _label;
      if (/gemini/.test(_ids))            { _water = true;  _label = "🔴 掺水：回来的 id 里带 gemini —— 名字挂着 claude，后面接的是 Gemini"; }
      else if (/^gpt|openai/.test(_ids))  { _water = true;  _label = "🔴 掺水：id 指向 OpenAI"; }
      else if (/chatcmpl/.test(_ids))     { _water = null;  _label = "回来的是 OpenAI 那套格式 —— 中转站把请求换过一道；但光凭 id 判断不了后面是谁"; }
      else if (/toolu_bdrk_/.test(_ids))  { _water = null;  _label = "Bedrock 风格的工具 id；仅凭 id 不能证明实际来源或模型血统"; }
      else if (/req_vrtx_/.test(_ids))    { _water = null;  _label = "Vertex 风格的响应 id；仅凭 id 不能证明实际来源或模型血统"; }
      else if (/^msg_01/.test(String(_mid || ""))) { _water = null; _label = "Anthropic 格式 id；仅凭 id 不能证明直连或模型血统"; }
      // 🔴 **拿不到 id ≠ 掺水。** 上一版这里一律判成掺水，
      // 于是「这一发没解析出 message_start」也会被写成「这条掺水了」——
      // **把「不知道」说成「有问题」，比不说更坏。**
      else if (!_mid)                     { _water = null;  _label = "这一发没拿到 id，认不出血统（不代表有问题）"; }
      else                                { _water = null;  _label = `id=${String(_mid).slice(0, 22)}，格式认不出；不能据此判定后端模型`; }
      const _forced = _forcedOK;
      return {
        // 没强制成功的时候，「没调」只能说明它这一轮没选择调，**不能判成不能调**
        verdict: _tool ? "会调" : (_forced ? "不会调" : "这轮没调（非强制，不算数）"),
        ok: _tool ? true : (_forced ? false : null),
        mode: _mode,
        detail: _tool
          ? `调了 ${_tool.name}，工具 id ${String(_tool.id).slice(0, 14)}… stop=${_stop}（${_mode}）`
          : `一个工具都没调，stop=${_stop}（${_mode}）`,
        watered: _water,
        mid: String(_mid || ""),
        genuine: _label
      };
    } catch (e) { return { verdict: "打不通", detail: String(e).slice(0, 80) }; }
  }

  // ── 真实用量（比探针可信，而且免费）──────────────────
  // 探针再像也只是像。**你真正跑过的那些轮次**才是证据。
  // 原始版本直接读自己的库；独立版靠 `--usage-file` 喂一份 JSONL，每行形如：
  //   {"in":8411,"cw":4125,"cr":133923,"model":"...","url":"host","ep":0,"stream":1}
  // 没有就跳过这一块 —— **跳过要说出来，不能默默当成「没命中」**（README §2）。
  function _realUsage() {
    if (!_usageFile) {
      return { rounds: 0, blind: 0, hit_rounds: 0, for_model: false, avg_total: null,
               note: "没给 --usage-file，这一块跳过了。**探针只是旁证，真实用量才是证据**（README §6）" };
    }
    try {
      const _rows = fs.readFileSync(String(_usageFile), "utf8").split("\n")
                      .map(s => s.trim()).filter(Boolean);
      const _all = [];
      for (const _line of _rows) {
        try {
          const _u = JSON.parse(_line);
          const _tot = (_u.in || 0) + (_u.cw || 0) + (_u.cr || 0);
          const _route = { model: _u.model, url: _u.url || "", ep: Number(_u.ep || 0), stream: Number(_u.stream ?? 1) };
          if (_tot === 0) { _all.push({ blind: true, ..._route }); continue; }
          _all.push({ in: _u.in || 0, cw: _u.cw || 0, cr: _u.cr || 0, total: _tot,
                      hit: (_u.cr || 0) > 0, ..._route });
        } catch (_e) {}
      }
      // 一条通道 = 站 + 模型 + 端点清单模式 + 流式模式。少任意一项都会把不同路径混算。
      const _mine = _all.filter(x => x.model === _model && x.url === _routeHost &&
                                     x.ep === _routeEp && x.stream === _routeStream);
      const _scoped = _mine.length >= 3;
      const _out = _mine.slice(0, 30);
      const _seen = _out.filter(x => !x.blind);
      const _hits = _seen.filter(x => x.hit).length;
      const _scope = _scoped ? "（只算当前完整通道：站 + 模型 + 端点清单 + 流式）"
                             : `（当前完整通道只有 ${_mine.length} 轮，样本不足；没有混入别的模型或设置）`;
      return {
        rounds: _out.length,
        blind: _out.filter(x => x.blind).length,
        hit_rounds: _hits,
        for_model: _scoped,
        avg_total: _seen.length ? Math.round(_seen.reduce((a, x) => a + x.total, 0) / _seen.length) : null,
        note: _out.length === 0 ? "这份样本里没有当前完整通道的轮次（没有拿别的模型来凑数）"
            : (_out.filter(x => x.blind).length === _out.length
               ? "这些轮站子一个用量数字都没返回 —— 看不见，不代表没花钱" + _scope
               : `${_seen.length} 轮看得见用量，其中 ${_hits} 轮命中缓存` + _scope)
      };
    } catch (e) { return { error: String(e).slice(0, 80) }; }
  }
  const _real = _realUsage();

  // ── 前缀稳不稳（这两天最贵的那一课）────────────────────
  // 缓存前缀 = tools → system → messages。**任何一段变了，后面全废。**
  // 08-14 的真凶就是工具块顺序每轮不同（长度一字不差、哈希在变），
  // 我盯着 len 相等看了两天。现在让按钮替她看。
  function _prefixHealth() {
    try {
      if (!_fpRingFile) return { note: "没给 --fp-ring，这一块跳过了（这是你自己网关记的前缀指纹，独立版拿不到）" };
      const _ring = JSON.parse(fs.readFileSync(String(_fpRingFile), 'utf8'));
      if (!Array.isArray(_ring) || _ring.length < 2) return { note: "还没攒够轮次（聊几轮再看）" };
      // 🔴 **只看同一个会话。** 不同会话的历史开头本来就不一样，
      // 拿它们互相比等于自己造红灯（同 08-15 早上「真实用量不分模型」那个坑）。
      const _routeRows = _ring.filter(x => x.model === _model && x.url === _routeHost &&
                                           Number(x.ep || 0) === _routeEp && Number(x.stream ?? 1) === _routeStream);
      if (!_routeRows.length) return { note: "当前完整通道还没有新版指纹记录（聊几轮再看）" };
      const _sess = _routeRows[_routeRows.length - 1].sess;
      const _pool = _sess != null ? _routeRows.filter(x => x.sess === _sess) : _routeRows;
      const _last = _pool.slice(-12);
      if (_last.length < 3) return { note: `这个会话只攒了 ${_last.length} 轮指纹，还看不出稳不稳（聊几轮再看）` };

      // 🔴 **「变过一次然后稳住」和「每轮都在变」是两回事。**
      // 前者是换了配置/拨了开关，一次性重写缓存，无害；
      // 后者才是真凶。原来只数有几个不同值，把这两种说成了同一件事。
      const _check = (k, label) => {
        const _vals = _last.map(x => x[k]).filter(Boolean);
        if (_vals.length < 2) return null;
        const _changes = _vals.filter((v, i) => i > 0 && v !== _vals[i - 1]).length;
        if (!_changes) return null;
        // 最后连着几轮没变 = 已经稳住了
        let _stable = 1;
        for (let i = _vals.length - 1; i > 0 && _vals[i] === _vals[i - 1]; i--) _stable++;
        return { label, changes: _changes, stable: _stable, settled: _stable >= 3 };
      };
      const _hits = [_check('tools', '完整工具定义'), _check('blk0', '人格提示词'),
                     _check('summary', '摘要'), _check('catalog', '端点清单'),
                     _check('m5', '最前面 5 条历史') || _check('m20', '前 20 条历史')].filter(Boolean);
      const _live = _hits.filter(h => !h.settled);      // 还在变的，这才是问题
      const _past = _hits.filter(h => h.settled);       // 变过但已经稳住的

      let _note;
      if (!_hits.length)
        _note = `最近 ${_last.length} 轮（同一完整通道、同一会话），完整工具 / 人格 / 摘要 / 端点清单 / 历史开头都没变 —— 已记录的前缀是稳的`;
      else if (_live.length)
        _note = `🔴 ${_live.map(h => `${h.label}还在变（最近 ${_last.length} 轮里变了 ${h.changes} 次）`).join("；")}` +
                ` —— 前缀一变后面全部作废，这是我们自己这边的问题，不是通道的` +
                (_past.length ? `。（${_past.map(h => h.label).join("、")}也变过，但最后 ${_past[0].stable} 轮已经稳住，那是一次性的，不用管）` : "");
      else
        _note = `${_past.map(h => `${h.label}变过 ${h.changes} 次`).join("；")}，但最后 ${_past[0].stable} 轮已经稳住 —— ` +
                `**这是一次性变化**（换了配置、拨了开关、或者我改了代码），只会多写一次缓存，之后就稳了。不用管`;

      return {
        rounds: _last.length,
        // 🔴 ok 只在「还在变」时才为 false。变过但稳住了不该报红 ——
        // 把一次性变化说成故障，跟把「不知道」说成「有问题」是同一个毛病。
        ok: _live.length === 0,
        note: _note
      };
    } catch (e) { return { note: "还没有指纹记录" }; }
  }
  const _prefix = _prefixHealth();

  // ── 这个模型会不会开扩展思考 ────────────────────────────
  // app 是靠**模型名里有没有 "thinking"** 自动判的。她 08-14 换到 `[官方客户端]`
  // （名字里没有）之后说「这个 cc 的模型神叨叨的」—— 那就是没有思考链的我。
  const _thinkAuto = /thinking/i.test(_model);
  const _think = {
    auto: _thinkAuto,
    note: _thinkAuto
      ? "模型名里带 thinking，扩展思考会自动开"
      : "🔴 模型名里没有 thinking —— 扩展思考**默认是关的**，除非在设置里手动拨到「开」。关着的我是张嘴就说的我"
  };

  // ── 有没有更新的版本（4-5 / 4-6 那一课）─────────────────
  async function _versionHint() {
    try {
      const _r = await fetch(_billBase + "/v1/models", {
        headers: { "Authorization": "Bearer " + _key }, signal: AbortSignal.timeout(20000)
      });
      if (!_r.ok) return null;
      const _ids = ((await _r.json()).data || []).map(m => m.id || "");
      const _m = _model.match(/(claude-[a-z]+)-(\d+)-(\d+)/i);
      if (!_m) return null;
      const _cur = parseInt(_m[2]) * 100 + parseInt(_m[3]);
      const _tag = _model.split(/claude-/i)[0];
      let _best = null, _bestV = _cur;
      for (const _id of _ids) {
        if (!_id.startsWith(_tag)) continue;
        const _mm = _id.match(/(claude-[a-z]+)-(\d+)-(\d+)/i);
        if (!_mm || _mm[1] !== _m[1]) continue;
        const _v = parseInt(_mm[2]) * 100 + parseInt(_mm[3]);
        if (_v > _bestV) { _bestV = _v; _best = _id; }
      }
      return _best ? { newer: _best, note: `同一条通道上还有更新的：${_best}。**版本号差一位，行为可能完全不同** —— 08-14 实测 opus-4-5 从不缓存、4-6 缓存` } : null;
    } catch (_e) { return null; }
  }
  const _version = await _versionHint();

  const _billStart = await _bill();
  // ── 工具计价（08-14 她要的）────────────────────────────
  // 她："某按量通道每轮 7.8 万，另一条才 4.4 万啊明明！"
  // 实测同一个工具数组：官方客户端报 7013、该通道报 25047（3.6 倍）、另一条按量通道恒 542（根本不算工具）。
  // **`input_tokens` 是中转站说的，不是事实**；按量计费的通道多算就是多收钱。
  // 做法：同样的消息，打两发（不带工具 / 带固定工具块），差值就是它给工具的计价。
  async function _countProbe() {
    const _desc = "这是一个用来撑体量的工具描述。".repeat(60);
    const _mkTools = (n) => Array.from({ length: n }, (_, i) => ({
      name: "probe_tool_" + i, description: _desc,
      input_schema: { type: "object", properties: { q: { type: "string" } } }
    }));
    const _tools6 = _mkTools(6);
    const _chars = JSON.stringify(_tools6).length;
    async function _in(tools) {
      const _b = { model: _model, max_tokens: 16, stream: false,
                   messages: [{ role: "user", content: "说一个字：好" }] };
      if (tools) { _b.tools = tools; _b.tool_choice = { type: "auto" }; }
      try {
        _shots++;
        const _r = await fetch(_url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + _key, "x-api-key": _key,
                     "anthropic-version": "2023-06-01" },
          body: JSON.stringify(_b), signal: AbortSignal.timeout(90000)
        });
        if (!_r.ok) return null;
        const _j = await _r.json();
        return _j?.usage?.input_tokens ?? null;
      } catch (_e) { return null; }
    }
    const _a = await _in(null);
    const _b2 = await _in(_tools6);
    if (_a == null || _b2 == null) return { verdict: "测不了", detail: "这两发没打通" };
    const _delta = _b2 - _a;
    // 中文为主的文本，正牌通道实测约 1.15 token/字符（官方客户端：6096 字符 → 7013）
    const _rate = _delta / _chars;
    const _ratio = _rate / 1.15;
    let _verdict, _why;
    if (_delta <= 50) {
      _verdict = "不算工具";
      _why = "带不带工具报的数一样 —— 它的用量数字不能信，看不见不等于没花钱";
    } else if (_ratio >= 2) {
      _verdict = `虚高约 ${_ratio.toFixed(1)} 倍`;
      _why = "同一块工具定义，它算出来是正牌通道的好几倍。按量计费的话，多算就是多收钱";
    } else if (_ratio <= 0.5) {
      _verdict = `偏低约 ${(1 / _ratio).toFixed(1)} 倍`;
      _why = "报得比正牌通道少 —— 账单未必跟着少，别当成省了";
    } else {
      _verdict = "正常";
      _why = "跟正牌通道的口径对得上";
    }
    return { verdict: _verdict, ratio: Number(_ratio.toFixed(2)),
             detail: `${_chars} 字符的工具块，它算成 ${_delta} token（≈${_rate.toFixed(2)} token/字符，正牌约 1.15）`,
             why: _why };
  }
  const _count = await _countProbe();

  const _ns = await _pair("NS", false);
  // 🔴 `--no-stream` 原来只改了归档口径（`_routeStream`），**流式那两发照打不误** ——
  // README 写着"只测非流式"，实际行为不是。外部 review 抓到的，别人一跑就能发现。
  // 跳过的时候标 `blind:true`：**我们没测 ≠ 它不缓存**，所以下游那条
  // 「非流式中了 + 流式没中 → 建议关流式」不许拿一发没打过的探针当证据。
  const _st = _routeStream
    ? await _pair("ST", true)
    : { verdict: "没测（用了 --no-stream）", skipped: true, blind: true,
        hit: undefined, thinking_back: undefined, saved: null,
        detail: "这一组一发都没打 —— 不是没命中，是没测" };
  const _tools = await _toolProbe();
  // 等它真的结清再读，别 sleep 一下就当数（原来 prev=null 让 _billSettle 第一拍就返回）
  const _billEnd = await _billSettle(_billStart, 25000) ?? await _bill();
  // 体检本身花了多少 —— 她有权在点之前就知道，也有权在点完看到账单对不对得上
  const _total = (_billStart != null && _billEnd != null) ? Math.max(0, _billEnd - _billStart) : null;
  // 🔴 **一句话的建议要按严重程度排，不是按代码写的顺序。**
  // 08-15 她那张截图：「这条根本不是 claude（掺的 Gemini）」被后面一句
  // 「计价虚高 3.6 倍」整个盖掉了 —— 最重的那条反而没出现在建议里。
  // 现在从轻往重写，最重的最后赋值。
  let _advice;
  // 🔴🔴 **08-15 实测抓到的：六发全 403，它却说「两条都不缓存 —— 换通道」。**
  // `_st.hit` / `_ns.hit` 都是 undefined，一路掉进最后那个 else，
  // 于是**「没测出来」被说成了「测出来是坏的」**。她照着换站就白换了。
  // 这跟「瞎的当成没命中」是同一族的错：**测不出来是第三种结论，不是坏消息的同义词。**
  const _errTxt = String(_st.detail || _ns.detail || "");
  const _quota = /额度|余额|insufficient|quota|balance|欠费/i.test(_errTxt);
  const _busy = /overloaded|temporarily unavailable|rate.?limit|too many requests|\b(429|502|503)\b/i.test(_errTxt);
  // 缓存那两条没测成时，「为什么没测成」不能被后面的结论挤掉 —— 先留一份
  let _cacheNote = null;
  if (_st.unreachable && _ns.unreachable) {
    _cacheNote = _busy
      ? `⏳ **这条通道现在过载了，不是它不缓存、也不是它掺水。**${_errTxt.slice(0, 150)}。过一会儿再测一次。`
      : _quota
      ? `🔴 **一发都没打出去 —— 这个 key 的额度不够了，不是通道的问题。**${_errTxt.slice(0, 150)}。先充值，再测。`
      : `🔴 **一发都没打出去，这次测不出任何结论。**${_errTxt.slice(0, 150)}。先把打不通解决掉，别拿这次结果去换通道。`;
    _advice = _cacheNote;
  }
  else if (_st.hit) _advice = "这组流式探针能命中；它不含完整聊天历史和端点清单，开关结论还要看下面的真实同通道记录。";
  else if (_ns.hit && _st.blind)
    _advice = "非流式测出命中；流式这条站子**不返回缓存字段**，是看不见、不是没中 —— 别只凭这个就关流式，先看「真实」那一段。";
  else if (_ns.hit) _advice = "这组探针只有非流式命中；它不等于真实聊天也只有非流式能中，先看下面的同通道记录再改开关。";
  else if (_st.blind && _ns.blind)
    _advice = "两条都不返回缓存字段 —— 这个站根本不让你看账，探针测不出来，以「真实」那一段为准。";
  else _advice = "两条都不缓存 —— 换通道。别在这条上耗着，每句话都是全价。";
  // 🔴 **「多算」只有在按量计费时才是钱。** 08-15 打 某按次通道（一次 ¥0.03）：
  // 计价虚高 4.2 倍被顶成了头条建议 —— 可它是**按次**计费的（一次 ¥0.03），
  // 多算多少都不影响她付多少。**结论要看计费口径，不能只看数字大。**
  const _perToken = /量/.test(_model);
  const _perCall = !_perToken && /次|￥/.test(_model);
  // 🔴 **关掉流式会不会丢思考链，必须在她关之前就告诉她。**
  // 08-15 实测这条通道：流式 thinking 410/207 字，非流式一个字都没有，
  // 而 output_tokens 照样收 92/170 —— 付钱买沉默。
  if (_st.thinking_back && _ns.unreachable !== true && _ns.thinking_back === false) {
    _advice = "⚠️ **这条通道非流式不返回思考链**（流式有，非流式一个字没有，而 output token 照收）"
            + " —— 不管缓存怎么说，**流式都得开着**。" + (_advice ? "另外：" + _advice : "");
  }
  if (_count && /虚高/.test(_count.verdict || "")) {
    _advice = _perCall
      ? `ℹ️ 这条**${_count.verdict}**地计算工具 token（${_count.detail}）—— 但它名字里带「次」，是**按次计费**的，多算不影响你付多少，这条可以不管。`
      : `🔴 这条通道**${_count.verdict}**地计算工具 token（${_count.detail}）。按量计费的话你一直在多付。`;
  }
  if (_tools.ok === false) _advice = "🔴 这条通道**不会调工具**（" + (_tools.genuine || "") + "）。缓存再省也没用，换通道。";
  // 🔴 别把 `genuine` 再塞进建议里 —— app 上面已经单独显示了那一行，
  // 于是同一句「掺水：id 里带 gemini…」在屏幕上出现两次（08-15 她截图里就是）。
  // **同一个事实说一遍就够，重复只会让人以为是两个问题。**
  if (_tools && _tools.watered === true) _advice = "🔴 **这条掺水了 —— 最要紧的是这条。**名字挂着 claude，后面接的不是；缓存、计价怎么测都没意义，换通道。";
  // ── 「该怎么选」──────────────────────────────────────────────
  // 她 08-15："在探针下面给我一个简单的总结 + 我该怎么选择。"
  // **吐一堆数字然后让她自己拼结论，是我偷懒。** 每一档只给一个值和一句理由。
  const _perTok = /量/.test(_model), _perCal = !_perTok && /次|￥/.test(_model);
  const _plan = { choices: [] };

  // 1) 能不能打中缓存 —— **以真实用量为准，探针只是旁证**
  const _realEnough = !!(_real && _real.for_model === true);
  const _realHit = _realEnough && _real.hit_rounds > 0;
  const _realSeen = _realEnough && _real.rounds > 0 && _real.blind < _real.rounds;
  _plan.verdict = _realHit ? "能命中"
                : (_realSeen ? "真实对话里还没中过"
                             : (_st.hit || _ns.hit ? "探针能中，真实同通道样本不足" : "测不出"));
  _plan.summary = _realHit
    ? `真实对话里 ${_real.hit_rounds}/${_real.rounds} 轮命中过，这条路是通的`
    : (_realSeen
        ? `探针${_st.hit || _ns.hit ? "能中，但" : "也没中，"}真实对话 ${_real.rounds} 轮一次没中 —— **以真实的为准**，探针的前缀比你的干净得多`
          + ((_ns.saved || _st.saved) ? `。上面那个「省 ${_ns.saved || _st.saved}」是探针拿它自己那点前缀省出来的，**你现在一分钱都拿不到**` : "")
        : `当前完整通道只有 ${_real?.rounds || 0} 轮，少于 3 轮不下结论；探针不含完整历史和端点清单`);

  // 2) 上游流式 —— 丢思考链这条**压倒缓存**
  // 🔴🔴 **真实和探针打架时，一律以真实为准，而且要明说探针不算数。**
  // 08-15 她抓到的：早上探针说「非流式命中 88%」→ 建议她关流式；
  // 后来发现非流式没思考链 → 又说开着。**两条建议的证据基础完全不同，
  // 而我每次都说得像已经定了。** 更根上的问题是：探针测的是 14k 的填充前缀，
  // 她真实是 68k —— 探针「命中」对它自己成立，对她的负载不成立。
  // 这是 08-14「探针骗了她」的重演：我修过探针的形状，没修它的**体量**。
  // 🔴🔴 **08-16 她抓到的第三次：同一份证据，两个门槛。**
  // 上面 `_plan.verdict` 用的是 `rounds > 0` —— 4 轮就敢下「真实对话里还没中过」；
  // 这里原来卡着 `rounds >= 5`，于是她那张卡上半段写着「以真实的为准，一次没中」，
  // 下半段却掉进「按思考链选」那条分支，拿探针的理由建议她开流式，
  // **而且顶上还挂着一个「省 89%」的大标题**。她："你说非流式才命中，
  // 但是又在建议里建议我开流式。"——两句话都对，摆在一起就是自相矛盾。
  // 门槛统一成跟 verdict 一样；证据强弱写进话里，不写进 if 里。
  const _probeOnly = !_realEnough;
  const _basisNote = _probeOnly
    ? `（🔴 **这条不是拿上面那些缓存数字选的** —— 真实同通道${_real && _real.rounds ? `只有 ${_real.rounds} 轮` : "还没有样本"}，`
      + `探针那点前缀说了不算。` + ((_ns.saved || _st.saved) ? `顶上那个「省 ${_ns.saved || _st.saved}」是探针自己省的。` : "") + `）`
    : "";
  const _realSaysNo = _realEnough && _realSeen && !_realHit;
  if (_realSaysNo)
    _plan.choices.push({ name: "上游流式", value: _st.thinking_back && _ns.thinking_back === false ? "开" : "都行",
      why: `**别拿探针的缓存结论选这个开关** —— 你真实 ${_real.rounds} 轮一次没命中`
           + (_real.rounds < 5 ? `（才 ${_real.rounds} 轮，样本还薄，但方向已经和探针相反）` : "")
           + `，探针那点前缀说了不算。`
           + ((_ns.saved || _st.saved) ? `顶上那个「省 ${_ns.saved || _st.saved}」是探针自己省的，不是你能省的。` : "")
           + (_st.thinking_back && _ns.thinking_back === false ? "按思考链选：非流式这条不返回思考链，所以开着。" : "两条链路在你的真实负载上没差别。") });
  // 🔴🔴🔴 **同一个病的第二处，08-16 深夜跑这个命令行版才发现的。**
  // 门槛改对了，可**分支顺序没改** —— 「按思考链选」排在「真实证据不够」前面，
  // 于是没有真实用量时（刚换通道，或者这个独立版没喂 --usage-file），
  // 它照样吐一句干净利落的「开 / 关掉就没有思考链了」，
  // **一个字都不提上面那些缓存数字支撑不了这个建议**。
  // 用户早上问的就是这个形状：「测出来非流式才缓存，最终建议却写推荐流式」。
  // 改门槛只治了「证据反对」，没治「证据不足」。**两种都得说出来。**
  // 🔴🔴🔴 **这个 `else` 是 08-16 深夜漏掉的，而漏掉它的正是"修建议自相矛盾"的那个补丁。**
  // 上面 `if (_realSaysNo)` 之后没有 else，于是真实证据反对时**两条都会 push**，
  // 报告里出现两个「上游流式」，一个说"都行"，紧接着一个说"开"。
  // 修矛盾的补丁自己造了一条矛盾 —— 外部 review 一眼看出来的。
  else if (_st.thinking_back && _ns.thinking_back === false)
    _plan.choices.push({ name: "上游流式", value: "开",
      why: "关掉就没有思考链了，而且那部分 output token 照样收钱" + _basisNote });
  else if (_probeOnly)
    _plan.choices.push({ name: "上游流式", value: _routeStream ? "保持开" : "保持关",
      why: "真实同通道少于 3 轮，探针又不含完整历史和端点清单；先保持当前设置，别为玩具探针改配置" });
  else if (_ns.hit && !_st.hit && !_st.blind)
    _plan.choices.push({ name: "上游流式", value: "关", why: "这条通道只有非流式能缓存；关掉的代价是首字要等整段生成完" });
  else if (_st.hit)
    _plan.choices.push({ name: "上游流式", value: "开", why: "流式这条就能缓存，什么都不用改" });
  else
    _plan.choices.push({ name: "上游流式", value: "开", why: "两条都没测出缓存优势，开着至少思考链是全的" });

  // 3) 端点清单 —— 只要它按量计费就一定值，按次的省的是上下文不是钱
  _plan.choices.push({
    name: "端点清单", value: "开",
    why: _perTok ? "84 个工具定义压成清单，每轮少算约 2.6 万 token；这条按量计费，少算就是少付"
                 : "每轮少塞约 2.6 万 token，上下文更宽；这条按次计费，省的不是钱是空间"
  });

  // 4) 这条通道留不留 —— 掺水/不会调工具是硬伤，虚高只在按量时算伤
  //
  // 🔴🔴 **这一格原来写死「换掉」，那是替她做决定。**
  // 她 2026-08-16 看到自己那条被判「换掉」时说：「这个通道居然掺水了啊……
  // 我感觉挺好吃的。」——**掺水是事实，难不难吃是另一件事，而后者只有她说了算。**
  // 这张卡该做的是：把硬事实和代价摆清楚（后端不是 claude、按量还虚算、缓存测不准），
  // 然后把「换不换」还给她。她要开源这个按钮，一个替用户拍板的判词更不该出去。
  if (_tools && _tools.watered === true)
    _plan.choices.push({ name: "这条通道", value: "建议换，具体看使用体验",
      why: "名字挂着 claude，后面接的不是 —— **缓存和计价在这条上怎么测都不作数**。"
           + (_perTok ? "而且它按量计费，多算就是多收钱。" : "")
           + "但好不好用你说了算：觉得它答得好就留着，只要知道这些数字别当真。" });
  else if (_tools && _tools.ok === false)
    _plan.choices.push({ name: "这条通道", value: "建议换，具体看使用体验",
      why: "强制它调工具它也不调 —— 缓存再省也没用。**只聊天不调工具的话它还是能用的**，看你拿它干什么。" });
  else if (_perTok && _count && /虚高/.test(_count.verdict || ""))
    _plan.choices.push({ name: "这条通道", value: "可以换", why: `它${_count.verdict}地计算工具 token，而这条按量计费 —— 折扣抵不过多算` });
  else if (_count && (_count.verdict === "不算工具" || /偏低/.test(_count.verdict || "")))
    _plan.choices.push({ name: "这条通道", value: "谨慎留", why: "工具能调，但 usage 的工具 token 口径不透明；这些数字不能证明计价没有问题" });
  else
    _plan.choices.push({ name: "这条通道", value: "可以留", why: "工具调用没有测出硬伤；响应 id 只代表格式，不作为模型血统证明" });

  // 5) 扩展思考（名字里没 thinking 就得手动开）
  if (_st.thinking_back === false && _ns.thinking_back === false)
    _plan.choices.push({ name: "扩展思考", value: "这条链路测不到", why: "探针已经主动开启 thinking，两条链路仍都没返回 thinking 块；手动拨开也不能保证拿得到" });
  else if (!_thinkAuto)
    _plan.choices.push({ name: "扩展思考", value: "手动拨到「开」", why: "模型名里没有 thinking，不手动开就是没有思考链的我" });

  // 最后把「缓存没测成的原因」补回去 —— 上面任何一条结论都不该把它吃掉
  if (_cacheNote && _advice !== _cacheNote)
    _advice += `（另外：缓存那两发没测成 —— ${_cacheNote.replace(/^[🔴⏳*\s]+/, "").replace(/\*\*/g, "")}）`;
  // 🔴 这里原来是三分法：掺水 / **正牌** / 认不出。
  // 可 `_water` 从头到尾只会是 `true` 或 `null` —— **`false` 那一档是死代码，永远不会走到**。
  // 更要紧的是概念：看到别家的标识能证明「被换过」，
  // 看到 `msg_01` 只证明「没看出被换过」，**那不叫正牌**。方向不对称，见 README §5。
  console.log(`[cache-check] ${_model}: 流式=${_st.verdict} 非流式=${_ns.verdict} 工具=${_tools.verdict}(${_tools.mode || "?"}) 血统=${_tools.watered === true ? "被换过（回来的不是 Claude）" : "认不出（不代表有问题）"} id=${_tools.mid || "?"} 计价=${_count.verdict} 真实=${_real.note || "?"} 本次花费=${_money(_total)}`);
  const _payload = { ok: true, model: _model, stream: _st, nonstream: _ns, tools: _tools,
                     real: _real, counting: _count, prefix: _prefix, thinking: _think, version: _version,
                     probe_calls: _shots, probe_cost: _money(_total),
                     // 刚打完的那一次也要有同一句话，不然她只在"复用"时看得见提示，
                     // 反过来就以为没提示 = 没测（同一个"沉默即正常"的坏习惯）。
                     run_kind: "刚测的",
                     // 🔴 服务端那版有 10 分钟复用缓存，命令行版没有（见文件末尾那段注释）。
                     // 这句话原样抠过来就是错的：**这里每跑一次都真花钱。**
                     run_line: `🔬 真打了 ${_shots} 发探针，花了 ${_money(_total) || "?"}。（命令行版每跑一次都会重新花钱，没有复用缓存）`,
                     // 全被站子挡回来的话，「打了 N 发花了 $0.0000」看着像 bug，得说明是没打成
                     blocked: !!(_st.unreachable && _ns.unreachable), plan: _plan,
                     // 这次探针撑的是什么前缀 —— **她有权知道这个结论是拿什么测出来的**
                     probe_prefix: _realPrefix
                       ? `探针用了当前人格 + 最近一份摘要样本（${_realPrefix.length} 字符），不含完整聊天历史和端点清单；只证明这组探针能否缓存`
                       : "🔴 读不到真实前缀，这次用的是填充文字 —— 结论只对这个玩具成立，别照着改开关",
                     advice: _advice };
  // 原始版本在这儿把结果存进 10 分钟的复用缓存、并解开在途锁 ——
  // 那两样是**服务端**才需要的（README §7.3～7.5：防重复的闸要设在花钱那一端）。
  // 命令行跑一次就是一次，没有并发的自己，所以这里不需要。
  // 🔴 但你要是把它包成一个按钮/接口，**那两道闸必须补回去**，
  //    否则用户连点五下就是扣五次钱。
  return _payload;
}

// ── 打印成人话 ──────────────────────────────────────────────
function report(p) {
  const L = [];
  const line = (s = "") => L.push(s);
  line("");
  line("═".repeat(60));
  line("  缓存体检 · " + p.model);
  line("═".repeat(60));
  const leg = (name, x) => {
    if (!x) return;
    line("");
    line(`【${name}】${x.verdict || "?"}`);
    if (x.cold_tokens != null || x.hot_tokens != null)
      line(`  没打中 ${x.cold_tokens ?? "看不到"} token · ${x.cold_cost ?? "?"}   ` +
           `打中 ${x.hot_tokens ?? "看不到"} token · ${x.hot_cost ?? "?"}` +
           (x.saved ? `   省 ${x.saved}` : ""));
    if (x.saved_note) line("  ⚠️ " + x.saved_note);
    if (x.detail) line("  " + x.detail);
  };
  leg("流式", p.stream);
  leg("非流式", p.nonstream);
  line("");
  line("【真实用量】" + (p.real?.note || "—"));
  line("【前缀】" + (p.prefix?.note || "—"));
  // 🔴 `_think` 只有 { auto, note }，没有 verdict —— 第一版我顺手写了 `.verdict`，
  // 于是这一行永远印「—」。**字段名要去产生它的那一端抄，不能凭印象写。**
  line("【思考】" + (p.thinking?.note || "—"));
  line("【计价】" + (p.counting?.verdict || "—") + (p.counting?.detail ? "\n  " + p.counting.detail : ""));
  line("【工具/血统】" + (p.tools?.verdict || "—") + (p.tools?.genuine ? "\n  " + p.tools.genuine : ""));
  if (p.version?.note) line("【版本】" + p.version.note);
  line("");
  line("─ 该怎么选 " + "─".repeat(46));
  line("  " + (p.plan?.verdict || "?") + "　" + (p.plan?.summary || ""));
  for (const c of (p.plan?.choices || [])) {
    line(`  · ${c.name}：${c.value}`);
    if (c.why) line("      " + String(c.why).replace(/\*\*/g, ""));
  }
  line("");
  line("  " + (p.probe_prefix || ""));
  line("  " + (p.run_line || ""));
  line("═".repeat(60));
  return L.join("\n");
}

main().then(p => {
  if (has("json")) { console.log(JSON.stringify(p, null, 2)); return; }
  console.log(report(p));
}).catch(e => {
  console.error("体检没跑成：" + (e && e.message || e));
  process.exit(1);
});
