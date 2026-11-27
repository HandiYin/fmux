// Feishu / Lark OIDC browser login portal (PRTS-styled owner-only gate).
export function renderOidcLoginGate({ appId, tenant }) {
  const brand = tenant === 'lark' ? 'Lark' : '飞书 Feishu';
  const safeAppId = String(appId || 'UNSET').replace(/[<>&"]/g, '');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>PRTS // FMUX IDENTITY VERIFICATION</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0d0f13; color: #f3f5f8; font-family: "Inter", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; overflow: hidden; }
  body {
    display: grid; place-items: center; padding: 24px; position: relative;
    background-image:
      radial-gradient(circle at 20% 20%, rgba(34, 187, 255, 0.08), transparent 45%),
      radial-gradient(circle at 80% 80%, rgba(255, 207, 0, 0.05), transparent 40%),
      linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
    background-size: 100% 100%, 100% 100%, 36px 36px, 36px 36px;
  }
  .bg-mark {
    position: fixed; right: -20px; bottom: -30px; font-family: "JetBrains Mono", monospace;
    font-size: 200px; font-weight: 900; letter-spacing: 0.08em; color: rgba(255,255,255,0.02);
    pointer-events: none; user-select: none; line-height: 0.85;
  }
  .reticle { position: fixed; width: 18px; height: 18px; border-color: rgba(255,255,255,0.22); border-style: solid; pointer-events: none; }
  .r-tl { top: 20px; left: 20px; border-width: 2px 0 0 2px; }
  .r-tr { top: 20px; right: 20px; border-width: 2px 2px 0 0; }
  .r-bl { bottom: 20px; left: 20px; border-width: 0 0 2px 2px; }
  .r-br { bottom: 20px; right: 20px; border-width: 0 2px 2px 0; }
  .gate {
    width: min(460px, 100%); background: rgba(19, 22, 28, 0.96); border: 1px solid rgba(255,255,255,0.16);
    clip-path: polygon(0 0, calc(100% - 24px) 0, 100% 24px, 100% 100%, 24px 100%, 0 calc(100% - 24px));
    box-shadow: 0 28px 80px rgba(0,0,0,0.7); position: relative;
  }
  .stripe { height: 4px; background: repeating-linear-gradient(-45deg, #ffcf00 0 10px, #13161c 10px 20px); }
  .inner { padding: 30px 28px 24px; }
  .head { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .kicker { font-family: "JetBrains Mono", monospace; font-size: 10px; letter-spacing: 0.22em; color: #22bbff; }
  h1 { margin: 2px 0 0; font-size: 21px; font-weight: 800; letter-spacing: 0.06em; }
  p { margin: 0 0 24px; font-size: 13.5px; color: #9ea8b8; line-height: 1.7; }
  code { font-family: "JetBrains Mono", monospace; font-size: 12px; color: #f3f5f8; background: rgba(255,255,255,0.07); padding: 1px 6px; }
  .btn {
    display: flex; align-items: center; justify-content: space-between; width: 100%;
    text-decoration: none; background: #f4f6f8; color: #0a0c10; font-family: "JetBrains Mono", monospace;
    font-weight: 800; padding: 14px 18px; letter-spacing: 0.1em; font-size: 13px;
    clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 0 100%);
    transition: background .15s;
  }
  .btn:hover { background: #22bbff; }
  .meta {
    margin-top: 22px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.08);
    display: flex; justify-content: space-between; font-family: "JetBrains Mono", monospace;
    font-size: 10px; letter-spacing: 0.12em; color: #6e7888;
  }
</style>
</head>
<body>
  <div class="reticle r-tl"></div><div class="reticle r-tr"></div><div class="reticle r-bl"></div><div class="reticle r-br"></div>
  <div class="bg-mark">PRTS</div>
  <div class="gate">
    <div class="stripe"></div>
    <div class="inner">
      <div class="head">
        <svg width="34" height="34" viewBox="0 0 32 32" fill="none">
          <polygon points="16,2 30,16 16,30 2,16" stroke="#f4f6f8" stroke-width="1.5"/>
          <polygon points="16,7 25,16 16,25 7,16" stroke="#22bbff" stroke-width="1.2"/>
          <rect x="14" y="14" width="4" height="4" fill="#22bbff"/>
        </svg>
        <div>
          <div class="kicker">RHODES ISLAND // PRTS NEURAL ACCESS</div>
          <h1>FMUX 战术控制台</h1>
        </div>
      </div>
      <p>需要通过 <strong>${brand} OIDC</strong> 校验操作员身份（<code>owner.openId</code>），验证通过后方可访问 Agent 会话、Heartbeat 调度、长期目标与 GPU 看板。</p>
      <a class="btn" href="/auth/login"><span>AUTHORIZE // ${brand.toUpperCase()} OIDC</span><span>→</span></a>
      <div class="meta"><span>APP: ${safeAppId}</span><span>SECURITY: OWNER_ONLY</span></div>
    </div>
  </div>
</body>
</html>`;
}
