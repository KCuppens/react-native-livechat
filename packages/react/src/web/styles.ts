/**
 * All messenger styles, scoped under .lc-root. Injected once into the document (or into
 * the widget's shadow root). Theme via CSS variables; --lc-primary comes from branding.
 */
export const MESSENGER_CSS = `
.lc-root{
  --lc-primary:#4F46E5;--lc-on-primary:#fff;
  --lc-bg:#fff;--lc-surface:#f6f7f9;--lc-surface-2:#eceef2;--lc-border:#e3e5ea;
  --lc-text:#111827;--lc-muted:#6b7280;--lc-danger:#dc2626;--lc-success:#16a34a;
  --lc-radius:16px;--lc-shadow:0 12px 48px rgba(17,24,39,.18),0 2px 8px rgba(17,24,39,.08);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  font-size:15px;line-height:1.45;color:var(--lc-text);-webkit-font-smoothing:antialiased;
}
@media (prefers-color-scheme:dark){.lc-root:not([data-theme="light"]){
  --lc-bg:#15171c;--lc-surface:#1e2128;--lc-surface-2:#272b33;--lc-border:#2e323b;--lc-text:#f3f4f6;--lc-muted:#9ca3af;
  --lc-shadow:0 12px 48px rgba(0,0,0,.5);
}}
.lc-root[data-theme="dark"]{--lc-bg:#15171c;--lc-surface:#1e2128;--lc-surface-2:#272b33;--lc-border:#2e323b;--lc-text:#f3f4f6;--lc-muted:#9ca3af}
.lc-root *,.lc-root *::before,.lc-root *::after{box-sizing:border-box}
.lc-root button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.lc-root button:focus-visible,.lc-root a:focus-visible,.lc-root textarea:focus-visible,.lc-root input:focus-visible{outline:2px solid var(--lc-primary);outline-offset:2px}
.lc-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

.lc-launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:60px;height:60px;border-radius:50%;
  background:var(--lc-primary)!important;color:var(--lc-on-primary)!important;box-shadow:var(--lc-shadow);display:grid;place-items:center;transition:transform .15s}
.lc-launcher:hover{transform:scale(1.05)}
.lc-launcher svg{width:28px;height:28px}
.lc-badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:var(--lc-danger);
  color:#fff;font-size:12px;font-weight:600;display:grid;place-items:center;border:2px solid var(--lc-bg)}

.lc-panel{position:fixed;right:20px;bottom:92px;z-index:2147483000;width:400px;height:min(680px,calc(100vh - 120px));
  background:var(--lc-bg);border-radius:var(--lc-radius);box-shadow:var(--lc-shadow);display:flex;flex-direction:column;overflow:hidden;
  animation:lc-in .18s ease-out}
.lc-panel.lc-inline{position:relative;right:auto;bottom:auto;width:100%;height:100%;box-shadow:none;border:1px solid var(--lc-border);animation:none}
@media (max-width:480px){.lc-panel:not(.lc-inline){inset:0;width:auto;height:auto;border-radius:0}}
@keyframes lc-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}

.lc-header{display:flex;align-items:center;gap:8px;padding:12px 12px;border-bottom:1px solid var(--lc-border);min-height:56px}
.lc-header-title{flex:1;min-width:0}
.lc-header-title strong{display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lc-header-title span{display:block;font-size:12px;color:var(--lc-muted)}
.lc-icon-btn{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;color:var(--lc-muted)}
.lc-icon-btn:hover{background:var(--lc-surface)}
.lc-icon-btn svg{width:20px;height:20px}
.lc-body{flex:1;overflow-y:auto;overscroll-behavior:contain}

.lc-hero{background:var(--lc-primary);color:var(--lc-on-primary);padding:24px 20px 56px;position:relative}
.lc-hero-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.lc-hero img{height:28px;max-width:140px;object-fit:contain}
.lc-hero h1{font-size:24px;line-height:1.25;margin:0;font-weight:700}
.lc-hero .lc-icon-btn{color:inherit}
.lc-hero .lc-icon-btn:hover{background:rgba(255,255,255,.15)}
.lc-home-cards{margin-top:-40px;padding:0 16px 16px;display:flex;flex-direction:column;gap:12px}
.lc-card{background:var(--lc-bg);border:1px solid var(--lc-border);border-radius:14px;box-shadow:0 2px 8px rgba(17,24,39,.05);overflow:hidden}
.lc-card-title{font-size:13px;font-weight:600;color:var(--lc-muted);padding:14px 16px 6px;text-transform:uppercase;letter-spacing:.02em}

.lc-search{display:flex;align-items:center;gap:8px;padding:0 14px;height:48px}
.lc-search svg{width:18px;height:18px;color:var(--lc-muted);flex:none}
.lc-search input{flex:1;border:0;background:none;font:inherit;color:inherit;height:100%;outline:none}
.lc-search input::placeholder{color:var(--lc-muted)}

.lc-row{display:flex;align-items:center;gap:12px;width:100%;padding:12px 16px;text-align:left;border-top:1px solid var(--lc-border)}
.lc-card .lc-row:first-child,.lc-card-title+.lc-row{border-top:0}
.lc-row:hover{background:var(--lc-surface)}
.lc-row-main{flex:1;min-width:0}
.lc-row-main strong{display:block;font-weight:500}
.lc-row-main span{display:block;font-size:13px;color:var(--lc-muted);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.lc-row>svg{width:18px;height:18px;color:var(--lc-muted);flex:none}
.lc-row-meta{font-size:12px;color:var(--lc-muted);white-space:nowrap}
.lc-dot{width:8px;height:8px;border-radius:50%;background:var(--lc-danger);flex:none}

.lc-cta{display:flex;align-items:center;gap:12px;padding:16px;width:100%;text-align:left}
.lc-cta:hover{background:var(--lc-surface)}
.lc-cta-main{flex:1}
.lc-cta-main strong{display:block}
.lc-cta-main span{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--lc-muted)}
.lc-cta>svg{width:20px;height:20px;color:var(--lc-primary)}
.lc-status-dot{width:8px;height:8px;border-radius:50%;background:var(--lc-muted)}
.lc-status-dot.lc-online{background:var(--lc-success)}

.lc-avatar{width:32px;height:32px;border-radius:50%;background:var(--lc-surface-2);color:var(--lc-text);display:grid;place-items:center;
  font-size:13px;font-weight:600;flex:none;overflow:hidden}
.lc-avatar img{width:100%;height:100%;object-fit:cover}
.lc-avatar.lc-brand{background:var(--lc-primary);color:var(--lc-on-primary)}

.lc-empty,.lc-loading,.lc-error-state{padding:32px 20px;text-align:center;color:var(--lc-muted)}
.lc-error-state button{margin-top:8px;color:var(--lc-primary);font-weight:500}
.lc-error-state .lc-error-actions{display:flex;gap:16px;justify-content:center}
.lc-spinner{width:22px;height:22px;border:2px solid var(--lc-border);border-top-color:var(--lc-primary);border-radius:50%;animation:lc-spin .8s linear infinite;margin:0 auto}
@keyframes lc-spin{to{transform:rotate(360deg)}}

.lc-article{padding:20px 20px 8px}
.lc-article h1{font-size:22px;line-height:1.3;margin:0 0 16px}
.lc-md{overflow-wrap:anywhere}
.lc-md p{margin:0 0 12px}
.lc-md h1,.lc-md h2,.lc-md h3,.lc-md h4{margin:20px 0 8px;line-height:1.3}
.lc-md h2{font-size:18px}.lc-md h3{font-size:16px}.lc-md h4{font-size:15px}
.lc-md ul,.lc-md ol{margin:0 0 12px;padding-left:22px}
.lc-md li{margin:4px 0}
.lc-md a{color:var(--lc-primary)}
.lc-md code{background:var(--lc-surface-2);padding:1px 5px;border-radius:5px;font-size:.9em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.lc-md pre{background:var(--lc-surface-2);padding:12px;border-radius:10px;overflow-x:auto;margin:0 0 12px}
.lc-md pre code{background:none;padding:0}
.lc-md blockquote{margin:0 0 12px;padding:4px 0 4px 12px;border-left:3px solid var(--lc-border);color:var(--lc-muted)}
.lc-md img{max-width:100%;border-radius:10px}
.lc-md hr{border:0;border-top:1px solid var(--lc-border);margin:16px 0}
.lc-md>:last-child{margin-bottom:0}
.lc-feedback{margin:8px 20px 16px;padding:16px;border-radius:14px;background:var(--lc-surface);text-align:center}
.lc-feedback-btns{display:flex;justify-content:center;gap:8px;margin-top:10px}
.lc-pill{padding:8px 18px;border-radius:999px;border:1px solid var(--lc-border)!important;background:var(--lc-bg)!important;font-weight:500}
.lc-pill:hover{border-color:var(--lc-primary)!important}
.lc-still{margin:0 20px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.lc-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 16px;border-radius:12px;
  background:var(--lc-primary)!important;color:var(--lc-on-primary)!important;font-weight:600}
.lc-btn:disabled{opacity:.5;cursor:default}
.lc-btn svg{width:18px;height:18px}

.lc-thread{display:flex;flex-direction:column;gap:2px;padding:16px 12px}
.lc-older{align-self:center;font-size:13px;color:var(--lc-primary);padding:6px 10px;margin-bottom:8px}
.lc-msg{display:flex;gap:8px;align-items:flex-end;max-width:85%}
.lc-msg.lc-mine{align-self:flex-end;flex-direction:row-reverse}
.lc-msg+.lc-msg{margin-top:2px}
.lc-msg.lc-first{margin-top:10px}
.lc-msg .lc-avatar{width:28px;height:28px;font-size:12px}
.lc-msg .lc-avatar.lc-hidden{visibility:hidden}
.lc-bubble-wrap{display:flex;flex-direction:column;min-width:0}
.lc-mine .lc-bubble-wrap{align-items:flex-end}
.lc-author{font-size:12px;color:var(--lc-muted);margin:0 0 3px 4px}
.lc-bubble{padding:9px 13px;border-radius:18px;background:var(--lc-surface);white-space:pre-wrap;overflow-wrap:anywhere}
.lc-mine .lc-bubble{background:var(--lc-primary);color:var(--lc-on-primary)}
.lc-mine .lc-bubble a{color:inherit}
.lc-bubble .lc-md p{margin:0}
.lc-bubble.lc-pending{opacity:.6}
.lc-bubble.lc-failed{background:none;border:1px solid var(--lc-danger);color:var(--lc-text)}
.lc-meta{font-size:12px;color:var(--lc-muted);margin:3px 6px 0}
.lc-meta.lc-danger{color:var(--lc-danger)}
.lc-system{align-self:center;font-size:12px;color:var(--lc-muted);margin:12px 0;text-align:center;max-width:85%}
.lc-system.lc-auto{background:var(--lc-surface);padding:10px 14px;border-radius:12px;font-size:13px;color:var(--lc-text);white-space:pre-wrap}
.lc-typing{display:inline-flex;gap:4px;padding:12px 14px;border-radius:18px;background:var(--lc-surface)}
.lc-typing i{width:6px;height:6px;border-radius:50%;background:var(--lc-muted);animation:lc-blink 1.2s infinite both}
.lc-typing i:nth-child(2){animation-delay:.2s}.lc-typing i:nth-child(3){animation-delay:.4s}
@keyframes lc-blink{0%,80%,100%{opacity:.3}40%{opacity:1}}
.lc-attachments{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.lc-mine .lc-attachments{justify-content:flex-end}
.lc-attachment-img{display:block;max-width:220px;max-height:220px;border-radius:12px;object-fit:cover;background:var(--lc-surface-2)}
.lc-attachment-file{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:12px;background:var(--lc-surface-2);color:inherit;text-decoration:none;font-size:13px}
.lc-attachment-file svg{width:18px;height:18px}

.lc-banner{padding:8px 12px;font-size:13px;text-align:center;background:var(--lc-surface);color:var(--lc-muted)}
.lc-suggest{border-top:1px solid var(--lc-border);padding:8px 0 0}
.lc-suggest .lc-card-title{padding:4px 16px}
.lc-suggest .lc-row{border-top:0;padding:8px 16px}
.lc-composer{border-top:1px solid var(--lc-border);padding:10px 10px 12px;display:flex;flex-direction:column;gap:8px}
.lc-composer-row{display:flex;align-items:flex-end;gap:6px}
.lc-composer textarea{flex:1;resize:none;border:1px solid var(--lc-border);border-radius:14px;padding:10px 12px;font:inherit;color:inherit;
  background:var(--lc-bg);max-height:140px;min-height:42px;line-height:1.4}
.lc-composer textarea:focus{outline:none;border-color:var(--lc-primary)}
.lc-send{width:42px;height:42px;border-radius:12px;background:var(--lc-primary)!important;color:var(--lc-on-primary)!important;display:grid;place-items:center;flex:none}
.lc-send:disabled{opacity:.4;cursor:default}
.lc-send svg{width:20px;height:20px}
.lc-chips{display:flex;flex-wrap:wrap;gap:6px}
.lc-chip{display:flex;align-items:center;gap:6px;padding:4px 6px 4px 10px;border-radius:999px;background:var(--lc-surface);font-size:13px;max-width:100%}
.lc-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px}
.lc-chip button{width:20px;height:20px;border-radius:50%;display:grid;place-items:center}
.lc-chip button svg{width:14px;height:14px}
.lc-chip.lc-uploading{opacity:.6}
.lc-chip.lc-chip-error{background:none;border:1px solid var(--lc-danger);color:var(--lc-danger)}
.lc-chip.lc-chip-error span{white-space:normal;max-width:none}

.lc-csat{align-self:stretch;margin:12px 8px;padding:16px;border-radius:14px;background:var(--lc-surface);text-align:center}
.lc-csat-scores{display:flex;justify-content:center;gap:6px;margin:12px 0}
.lc-csat-scores button{width:44px;height:44px;border-radius:12px;font-size:22px;background:var(--lc-bg)!important;border:1px solid var(--lc-border)!important;transition:transform .1s}
.lc-csat-scores button:hover,.lc-csat-scores button[aria-checked="true"]{border-color:var(--lc-primary)!important;transform:scale(1.08)}
.lc-csat textarea{width:100%;border:1px solid var(--lc-border);border-radius:10px;padding:8px 10px;font:inherit;color:inherit;background:var(--lc-bg);resize:vertical;min-height:60px;margin-bottom:10px}
`;

const INJECTED = new WeakSet<Document | ShadowRoot>();

export function injectStyles(root: Document | ShadowRoot = document): void {
  if (INJECTED.has(root)) return;
  INJECTED.add(root);
  const style = document.createElement("style");
  style.setAttribute("data-livechat", "");
  style.textContent = MESSENGER_CSS;
  // Duck-typed: `instanceof Document` fails across realms (iframes, test DOMs).
  (("head" in root && root.head) || root).appendChild(style);
}
