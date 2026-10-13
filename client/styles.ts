/** Compact editing surfaces, using the inspected host theme contract. */
export const STYLES = `
.nai-root, .nai-root * { box-sizing: border-box; }
.nai-root {
  --nai-bg: var(--dsw-alias-bg-base, Canvas);
  --nai-panel: var(--dsw-alias-bg-layer-1, Canvas);
  --nai-panel-2: var(--dsw-alias-bg-layer-2, Canvas);
  --nai-panel-3: var(--dsw-alias-interactive-bg-active, color-mix(in srgb, CanvasText 10%, Canvas));
  --nai-border: var(--dsw-alias-border-l3, color-mix(in srgb, CanvasText 20%, transparent));
  --nai-border-soft: var(--dsw-alias-border-l2, color-mix(in srgb, CanvasText 12%, transparent));
  --nai-text: var(--dsw-alias-label-primary, CanvasText);
  --nai-dim: var(--dsw-alias-label-secondary, CanvasText);
  --nai-faint: var(--dsw-alias-label-tertiary, GrayText);
  --nai-accent: var(--dsw-alias-state-business-primary, LinkText);
  --nai-accent-fill: var(--dsw-alias-button-primary-fill, ButtonText);
  --nai-accent-foreground: var(--dsw-alias-label-primary-foreground, ButtonFace);
  --nai-accent-hover: var(--dsw-alias-button-primary-hover, ButtonText);
  --nai-accent-soft: color-mix(in srgb, var(--nai-accent) 10%, transparent);
  --nai-ok: var(--dsw-alias-state-success-primary, #34b98b);
  --nai-warn: var(--dsw-alias-state-warn-primary, #cc9b3f);
  --nai-danger: var(--dsw-alias-state-error-primary, #e3636a);
  --nai-hover: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--nai-text) 5%, transparent));
  --nai-radius: 8px;
  container: atelier / inline-size;
  height: 100%; min-height: 0; min-width: 0;
  display: flex; flex-direction: column;
  background: var(--nai-bg); color: var(--nai-text);
  font: var(--dsw-font-s-14, 14px/22px var(--dsw-font-family, system-ui, sans-serif));
  letter-spacing: normal;
}
.nai-root button, .nai-root input, .nai-root textarea, .nai-root select { font: inherit; }
.nai-root button { color: inherit; }
.nai-root input, .nai-root textarea, .nai-root select {
  color: var(--nai-text); background: var(--nai-panel);
  border: 1px solid var(--nai-border); border-radius: 6px;
  padding: 7px 10px; outline: none; min-width: 0; max-width: 100%;
  transition: border-color .12s ease, box-shadow .12s ease;
}
.nai-root input:not([type="checkbox"]):not([type="range"]):not([type="file"]), .nai-root select { min-height: 34px; }
.nai-root input[type="checkbox"], .nai-root input[type="range"] { accent-color: var(--nai-accent); }
.nai-root input:focus, .nai-root textarea:focus, .nai-root select:focus { border-color: var(--nai-accent); box-shadow: 0 0 0 2px var(--nai-accent-soft); }
.nai-root textarea { resize: vertical; }
.nai-root a { color: var(--nai-accent); }
.nai-root ::placeholder { color: var(--nai-faint); opacity: .9; }
.nai-root :focus-visible { outline: 2px solid var(--nai-accent); outline-offset: 3px; }
.nai-root ::-webkit-scrollbar { width: 8px; height: 8px; }
.nai-root ::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--nai-dim) 25%, transparent); border-radius: 4px; border: 2px solid transparent; background-clip: padding-box; }
.nai-root ::-webkit-scrollbar-thumb:hover { background-color: color-mix(in srgb, var(--nai-dim) 50%, transparent); }
.nai-icon { width: 16px; height: 16px; flex: none; vertical-align: middle; }
.nai-shell { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.nai-topbar { display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--nai-border-soft); background: var(--nai-bg); flex-wrap: wrap; }
.nai-topbar .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.nai-brand-mark { color: var(--nai-accent); display: flex; align-items: center; }
.nai-brand-name { font-weight: 600; font-size: 15px; }
.nai-brand-version { font-size: 11px; color: var(--nai-faint); }
.nai-topbar .spacer { flex: 1; }
.nai-topbar-actions { display: flex; gap: 8px; align-items: center; margin-left: auto; flex-wrap: wrap; }
.nai-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border: 1px solid var(--nai-border-soft); border-radius: 5px; color: var(--nai-dim); font-size: 11px; white-space: nowrap; }
.nai-root button.nai-pill { background: transparent; cursor: pointer; min-height: 30px; }
.nai-pill.ok { color: var(--nai-ok); }
.nai-pill.bad { color: var(--nai-danger); }
.nai-pill:hover:is(button) { background: var(--nai-hover); }
.nai-body { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.nai-nav { display: flex; flex-direction: row; gap: 4px; padding: 0 14px; border-bottom: 1px solid var(--nai-border-soft); flex: none; overflow-x: auto; scrollbar-width: thin; }
.nai-nav button { position: relative; display: flex; align-items: center; justify-content: center; gap: 7px; padding: 11px 12px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--nai-dim); font-size: 12px; cursor: pointer; white-space: nowrap; flex: none; }
.nai-nav button:hover { color: var(--nai-text); background: var(--nai-hover); }
.nai-nav button.active { color: var(--nai-accent); border-bottom-color: var(--nai-accent); font-weight: 600; }
.nai-nav .nai-nav-badge { min-width: 16px; height: 16px; padding: 0 4px; font-size: 10px; line-height: 16px; border-radius: 4px; color: var(--nai-accent); background: var(--nai-accent-soft); }
.nai-main { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 20px 22px 28px; scrollbar-gutter: stable; }
.nai-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 6px 11px; border-radius: 6px; border: 1px solid var(--nai-border); color: var(--nai-text); background: var(--nai-panel); cursor: pointer; max-width: 100%; white-space: nowrap; transition: background .12s ease, border-color .12s ease; }
.nai-btn:hover { border-color: var(--nai-faint); background: var(--nai-panel-2); }
.nai-btn:disabled { opacity: .45; cursor: not-allowed; }
.nai-btn.primary { background: var(--nai-accent-fill); border-color: transparent; color: var(--nai-accent-foreground); font-weight: 600; }
.nai-btn.primary:hover:not(:disabled) { background: var(--nai-accent-hover); }
.nai-btn.danger { color: var(--nai-danger); border-color: color-mix(in srgb, var(--nai-danger) 45%, var(--nai-border)); }
.nai-btn.danger:hover { background: color-mix(in srgb, var(--nai-danger) 10%, var(--nai-bg)); }
.nai-btn.ghost { background: transparent; border-color: transparent; color: var(--nai-dim); }
.nai-btn.ghost:hover { background: var(--nai-hover); color: var(--nai-text); }
.nai-btn.small { min-height: 28px; padding: 4px 8px; font-size: 12px; }
.nai-btn.icon-only { width: 34px; height: 34px; padding: 0; flex: none; }
.nai-btn.icon-only.small { width: 28px; height: 28px; }
.nai-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; background: transparent; border: 0; border-radius: 5px; cursor: pointer; flex: none; }
.nai-icon-btn:hover { background: var(--nai-hover); }
.nai-card { padding: 0; min-width: 0; background: transparent; border: 0; border-radius: 0; }
.nai-card + .nai-card { border-top: 1px solid var(--nai-border-soft); margin-top: 24px; padding-top: 20px; }
.nai-section-title { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font-size: 13px; font-weight: 600; color: var(--nai-text); }
.nai-adv { margin-top: 16px; border-top: 1px solid var(--nai-border-soft); padding-top: 10px; }
.nai-adv > summary { cursor: pointer; user-select: none; color: var(--nai-dim); font-size: 12px; padding: 3px 0; }
.nai-adv > summary:hover { color: var(--nai-text); }
.nai-adv-body { padding-top: 12px; }
.nai-grid { display: grid; gap: 12px; }
.nai-grid > *, .nai-field { min-width: 0; }
.nai-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.nai-field { display: flex; flex-direction: column; gap: 6px; }
.nai-field > label { font-size: 12px; font-weight: 500; color: var(--nai-dim); }
.nai-field .hint { font-size: 11px; color: var(--nai-faint); overflow-wrap: anywhere; }
.nai-prompt textarea { width: 100%; min-height: 152px; line-height: 1.7; padding: 12px; }
.nai-prompt .prompt-meta { margin-top: 6px; font-size: 11px; color: var(--nai-faint); text-align: right; font-variant-numeric: tabular-nums; }
.nai-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.nai-tag { padding: 2px 7px; font-size: 11px; border-radius: 4px; background: var(--nai-panel); border: 1px solid var(--nai-border-soft); color: var(--nai-dim); }
.nai-tag.click { cursor: pointer; }
.nai-tag.click:hover { color: var(--nai-text); border-color: var(--nai-faint); }
.nai-workspace { display: grid; grid-template-columns: minmax(0, 1fr); gap: 22px; }
.nai-workspace > .nai-card + .nai-card { margin: 0; padding-top: 16px; }
.nai-workspace-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.nai-workspace-header-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
.nai-workspace-heading { min-width: min(180px, 100%); flex: 1 1 220px; }
.nai-workspace-header h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; overflow-wrap: anywhere; line-height: 1.4; }
.nai-workspace-context { color: var(--nai-faint); font-size: 11px; }
.nai-save-state { display: inline-flex; align-items: center; gap: 6px; color: var(--nai-faint); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nai-save-state[data-save-status="saved"] > .nai-icon { color: var(--nai-ok); }
.nai-save-state[data-save-status="failed"] { color: var(--nai-danger); }
.nai-revision { padding-left: 8px; border-left: 1px solid var(--nai-border-soft); color: var(--nai-faint); }
.nai-save-recovery { padding: 12px; border-left: 3px solid var(--nai-danger); background: color-mix(in srgb, var(--nai-danger) 7%, var(--nai-bg)); }
.nai-save-recovery p { margin: 4px 0 10px; color: var(--nai-dim); overflow-wrap: anywhere; }
.nai-mode-bar { display: flex; align-items: flex-start; gap: 8px; }
.nai-mode-group { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; }
.nai-btn.nai-mode { min-height: 32px; border-color: var(--nai-border-soft); background: transparent; color: var(--nai-dim); }
.nai-btn.nai-mode[aria-pressed="true"] { background: var(--nai-accent-soft); color: var(--nai-accent); border-color: color-mix(in srgb, var(--nai-accent) 50%, var(--nai-border)); }
.nai-workspace-submit { border-top: 1px solid var(--nai-border-soft); padding-top: 18px; }
.nai-command-bar { margin-top: 16px; gap: 8px; }
.nai-command-context { color: var(--nai-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.nai-command-bar > .primary { min-width: 112px; }
.nai-quote-result { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 14px; padding: 10px 0; color: var(--nai-dim); font-size: 12px; }
.nai-quote-result > .nai-icon { color: var(--nai-accent); }
.nai-artwork-preview { height: 320px; width: 100%; overflow: hidden; background: var(--nai-panel); border: 1px solid var(--nai-border-soft); cursor: pointer; }
.nai-artwork-caption { display: flex; align-items: center; justify-content: space-between; padding-top: 6px; color: var(--nai-faint); font-size: 11px; }
.nai-references { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.nai-reference { padding: 12px 0; border-top: 1px solid var(--nai-border-soft); }
.nai-reference-title { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 12px; }
.nai-reference-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--nai-faint); }
.nai-reference .nai-field { flex: 1; min-width: 95px; }
.nai-jobs-strip { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 14px; }
.nai-jobs-strip .job { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid var(--nai-border-soft); border-radius: 5px; background: transparent; font-size: 11px; cursor: pointer; }
.nai-jobs-strip .job:hover { background: var(--nai-hover); }
.nai-jobs-strip .job img { width: 22px; height: 22px; border-radius: 3px; object-fit: cover; }
.nai-jobs-strip .st-done { color: var(--nai-ok); }
.nai-jobs-strip .st-run { color: var(--nai-accent); }
.nai-jobs-strip .st-fail { color: var(--nai-danger); }
.nai-warn, .nai-error, .nai-okbox { padding: 9px 12px; border: 1px solid; border-radius: 6px; font-size: 12px; overflow-wrap: anywhere; }
.nai-warn { color: var(--nai-warn); background: color-mix(in srgb, var(--nai-warn) 7%, var(--nai-bg)); border-color: color-mix(in srgb, var(--nai-warn) 30%, var(--nai-border)); }
.nai-error { color: var(--nai-danger); background: color-mix(in srgb, var(--nai-danger) 7%, var(--nai-bg)); border-color: color-mix(in srgb, var(--nai-danger) 30%, var(--nai-border)); }
.nai-okbox { color: var(--nai-ok); background: color-mix(in srgb, var(--nai-ok) 7%, var(--nai-bg)); border-color: color-mix(in srgb, var(--nai-ok) 30%, var(--nai-border)); }
.nai-modal-backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; padding: 12px; }
.nai-modal { display: flex; flex-direction: column; color: var(--nai-text); background: var(--nai-panel); border: 1px solid var(--nai-border); border-radius: 8px; min-width: 0; width: min(760px, calc(100vw - 24px)); max-width: calc(100vw - 24px); max-height: calc(100dvh - 24px); box-shadow: 0 12px 40px rgba(0,0,0,.2); overflow: hidden; }
.nai-modal-header { display: flex; align-items: center; gap: 12px; justify-content: space-between; flex: none; padding: 12px 16px; border-bottom: 1px solid var(--nai-border-soft); }
.nai-modal-header h2 { margin: 0; min-width: 0; overflow-wrap: anywhere; font-size: 14px; font-weight: 600; }
.nai-modal-body { padding: 16px; overflow: auto; min-height: 0; container: atelier-dialog / inline-size; }
.nai-modal-footer { padding: 12px 16px; border-top: 1px solid var(--nai-border-soft); flex: none; }
.nai-modal .modal-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; flex-wrap: wrap; }
.nai-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(190px, 100%), 1fr)); gap: 14px; }
.nai-gallery .cell { display: flex; flex-direction: column; position: relative; min-width: 0; border-radius: 8px; overflow: hidden; border: 1px solid var(--nai-border-soft); background: var(--nai-panel); cursor: pointer; transition: border-color .12s ease; }
.nai-gallery .cell:hover, .nai-gallery .cell[aria-selected="true"] { border-color: var(--nai-accent); }
.nai-gallery .cell .img-wrap { width: 100%; aspect-ratio: 4/5; background: var(--nai-panel-2); display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; }
.nai-gallery .cell .img-wrap img { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; display: block; }
.nai-gallery .empty-thumb { height: 100%; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; color: var(--nai-faint); font-size: 12px; padding: 12px; }
.nai-gallery .meta { padding: 10px 12px; font-size: 11px; color: var(--nai-dim); display: flex; flex-direction: column; gap: 8px; }
.nai-gallery .meta-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-variant-numeric: tabular-nums; }
.nai-gallery .meta-prompt { font-size: 12px; color: var(--nai-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nai-gallery .flags { position: absolute; top: 8px; right: 8px; display: flex; gap: 4px; z-index: 2; }
.nai-gallery .flags span, .nai-gallery .flags button { display: inline-flex; align-items: center; gap: 4px; background: rgba(24,26,29,.88); color: #fff; border: 1px solid rgba(255,255,255,.18); border-radius: 4px; padding: 3px 6px; font-size: 10px; }
.nai-lib-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(230px, 100%), 1fr)); gap: 14px; }
.nai-lib-card { border-radius: 8px; border: 1px solid var(--nai-border-soft); background: var(--nai-panel); overflow: hidden; display: flex; flex-direction: column; min-width: 0; cursor: pointer; transition: border-color .12s ease; }
.nai-lib-card:hover { border-color: var(--nai-accent); }
.nai-lib-card .preview-box { width: 100%; aspect-ratio: 4/3; background: var(--nai-panel-2); display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden; }
.nai-lib-card .preview-box img { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; display: block; }
.nai-lib-card .preview-empty { color: var(--nai-faint); display: flex; flex-direction: column; align-items: center; gap: 8px; }
.nai-lib-card .content { padding: 12px; display: flex; flex-direction: column; gap: 8px; flex: 1; min-width: 0; }
.nai-lib-card .header-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.nai-lib-card .name { font-size: 13px; font-weight: 600; color: var(--nai-text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nai-lib-card .prompt-preview { font-size: 11px; color: var(--nai-dim); line-height: 1.55; min-height: 51px; max-height: 51px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.nai-lib-card .actions { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--nai-border-soft); flex-wrap: wrap; }
.nai-sched-card { border-radius: 8px; border: 1px solid var(--nai-border-soft); background: var(--nai-panel); padding: 14px; display: flex; gap: 14px; align-items: flex-start; }
.nai-sched-card:hover { border-color: var(--nai-accent); }
.nai-sched-thumb { width: 90px; height: 90px; border-radius: 5px; background: var(--nai-panel-2); overflow: hidden; flex: none; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.nai-sched-thumb img { max-width: 100%; max-height: 100%; object-fit: contain; }
.nai-countdown { display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px; border-radius: 4px; background: var(--nai-accent-soft); color: var(--nai-accent); font-size: 11px; font-variant-numeric: tabular-nums; }
.nai-list { display: flex; flex-direction: column; gap: 6px; }
.nai-list .item, .nai-list.item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 6px; border: 1px solid var(--nai-border-soft); background: var(--nai-panel); cursor: pointer; }
.nai-list .item:hover, .nai-list.item:hover { border-color: var(--nai-accent); }
.nai-list .item.selected, .nai-list.item.selected { border-color: var(--nai-accent); background: var(--nai-accent-soft); }
.nai-list .item .grow, .nai-list.item .grow { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.nai-list .item .sub, .nai-list.item .sub { font-size: 11px; color: var(--nai-faint); }
.nai-empty { color: var(--nai-faint); text-align: center; padding: 40px 12px; }
.nai-spin { animation: nai-spin 1s linear infinite; display: inline-flex; }
@keyframes nai-spin { to { transform: rotate(360deg); } }
.nai-image { position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; min-width: 0; }
.nai-image > img { display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; }
.nai-image-loading { position: absolute; color: var(--nai-faint); background: var(--nai-panel); padding: 5px; border-radius: 5px; }
.nai-image-error { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 12px; color: var(--nai-faint); font-size: 12px; }
.nai-kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 16px; font-size: 12px; overflow-wrap: anywhere; }
.nai-kv .k { color: var(--nai-faint); }
.nai-params { border-top: 1px solid var(--nai-border-soft); padding: 12px 0; }
.nai-param-json { margin: 0; padding: 10px; background: var(--nai-panel-2); border: 1px solid var(--nai-border-soft); border-radius: 5px; font: 12px/1.6 var(--ds-font-family-code, monospace); color: var(--nai-dim); max-height: 220px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.nai-mask-canvas { cursor: crosshair; max-width: 100%; touch-action: none; }
.nai-file-input { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
.nai-btn:focus-within { outline: 2px solid var(--nai-accent); outline-offset: 3px; }
.nai-preview-details { overflow-wrap: anywhere; min-width: 0; }
.nai-preview-details .nai-btn { white-space: normal; text-align: left; }
.nai-preview-image { width: 100%; height: min(56vh, 560px); margin-bottom: 8px; border-radius: 8px; background: var(--nai-bg); }
.nai-shell-error { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--nai-border-soft); }
.nai-shell-error > .nai-error { flex: 1; }
.nai-warnings { grid-column: 1 / -1; }
.nai-selection-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 0; margin-bottom: 12px; border-block: 1px solid var(--nai-border-soft); font-size: 12px; }
.nai-gallery-selection { position: absolute; top: 8px; left: 8px; z-index: 3; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 4px; background: rgba(24,26,29,.85); cursor: pointer; }
.nai-gallery-selection input { margin: 0; width: 16px; height: 16px; }
.nai-gallery[data-density="compact"] { grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr)); gap: 10px; }
.nai-gallery[data-density="compact"] .meta { padding: 8px; }
.nai-command-bar > .primary { margin-left: auto; }
.nai-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.nai-search { flex: 1; min-width: min(180px, 100%); position: relative; }
.nai-search > .nai-icon { position: absolute; left: 10px; top: 10px; color: var(--nai-faint); pointer-events: none; }
.nai-search input { width: 100%; padding-left: 34px; }
.nai-segmented { display: flex; gap: 2px; padding: 3px; background: var(--nai-panel); border: 1px solid var(--nai-border-soft); border-radius: 6px; }
.nai-segmented .nai-btn { min-height: 28px; border: 0; padding: 4px 8px; background: transparent; color: var(--nai-dim); }
.nai-segmented .nai-btn[aria-pressed="true"] { background: var(--nai-panel-3); color: var(--nai-text); }
@container atelier (min-width: 960px) {
  .nai-workspace { grid-template-columns: minmax(0, 1fr) 300px; column-gap: 26px; }
  .nai-workspace-header, .nai-workspace-operations, .nai-workspace-submit, .nai-workspace > .nai-save-recovery, .nai-workspace > .nai-error, .nai-workspace > .nai-okbox, .nai-workspace > .nai-warn { grid-column: 1 / -1; }
  .nai-workspace-prompt, .nai-workspace-references { grid-column: 1; }
  .nai-workspace-parameters { grid-column: 2; grid-row: span 2; border-left: 1px solid var(--nai-border-soft); border-top: 0 !important; padding-left: 22px; padding-top: 0 !important; }
  .nai-workspace-parameters .nai-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  .nai-workspace-parameters .nai-field:first-child { grid-column: 1 / -1; }
  .nai-workspace-preview { grid-column: 1; }
  .nai-artwork-preview { height: 280px; }
}
@container atelier (max-width: 620px) {
  .nai-topbar { padding: 10px 12px; gap: 8px; }
  .nai-brand-version { display: none; }
  .nai-nav { padding: 0 6px; }
  .nai-nav button { padding: 10px; gap: 6px; }
  .nai-main { padding: 16px 12px 24px; }
  .nai-workspace-header-actions { width: 100%; justify-content: space-between; }
  .nai-workspace { gap: 18px; }
  .nai-grid { grid-template-columns: repeat(auto-fit, minmax(min(135px, 100%), 1fr)) !important; }
  .nai-command-bar .nai-command-context { flex-basis: 100%; }
  .nai-lib-card .actions { gap: 6px; }
  .nai-sched-card { flex-wrap: wrap; }
}
@container atelier-dialog (max-width: 560px) {
  .nai-preview-details { width: 100% !important; flex-basis: 100% !important; }
  .nai-preview-media { flex-basis: 100%; min-width: 0 !important; }
  .nai-grid { grid-template-columns: minmax(0, 1fr) !important; }
}
@media (max-width: 480px) {
  .nai-topbar-actions { width: 100%; margin-left: 0; }
  .nai-modal-backdrop { padding: 8px; }
  .nai-modal-body { padding: 12px; }
  .nai-modal-header, .nai-modal-footer { padding: 10px 12px; }
}
@media (prefers-reduced-motion: reduce) { .nai-root *, .nai-root *::before { transition: none !important; animation: none !important; } }
`
