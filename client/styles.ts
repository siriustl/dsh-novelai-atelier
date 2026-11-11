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
/* Gallery masonry assigns cards to the shortest column in API order, so newest
   works read left to right; the outer wrapper must not constrain that layout. */
.nai-gallery[data-layout="columns"] { display: flex; align-items: flex-start; gap: 16px; }
.nai-gallery[data-layout="columns"] > .nai-gallery-column { display: flex; flex: 1 1 0; max-width: 320px; min-width: 0; flex-direction: column; gap: 16px; }
.nai-gallery .cell { display: flex; flex-direction: column; position: relative; min-width: 0; border-radius: 8px; overflow: hidden; border: 1px solid var(--nai-border-soft); background: var(--nai-panel); cursor: pointer; transition: border-color .12s ease; }
.nai-gallery .cell:hover, .nai-gallery .cell[aria-selected="true"] { border-color: var(--nai-accent); }
.nai-gallery .cell .img-wrap { width: 100%; aspect-ratio: 4/5; background: var(--nai-panel-2); display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; }
.nai-gallery .cell .img-wrap img { width: 100%; height: 100%; object-fit: contain; display: block; }
.nai-gallery .empty-thumb { height: 100%; min-height: 120px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; color: var(--nai-faint); font-size: 12px; padding: 12px; }
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
.nai-gallery-filters .nai-field { min-width: 130px; flex: 1 1 130px; }
.nai-gallery-filters .nai-field input, .nai-gallery-filters .nai-field select { width: 100%; min-width: 0; }
.nai-lib-card { position: relative; }
.nai-library-selection { position: absolute; z-index: 4; top: 8px; right: 8px; display: flex; width: 28px; height: 28px; align-items: center; justify-content: center; border-radius: 4px; background: rgba(24,26,29,.88); cursor: pointer; }
.nai-library-selection input { width: 16px; height: 16px; margin: 0; }
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
.nai-inspiration .nai-image > img { width: 100%; height: 100%; object-fit: contain; }
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
.nai-modal-body:has(> .nai-image-inspector-stage) { display: flex; flex-direction: column; overflow: hidden; }
.nai-image-inspector-stage { position: relative; height: min(68vh, 760px); min-height: 0; flex: 1 1 auto; overflow: hidden; background: #101214; touch-action: none; display: flex; align-items: center; justify-content: center; }
.nai-image-inspector-controls { display: flex; align-items: center; justify-content: center; gap: 6px; flex-wrap: wrap; }
.nai-image-inspector-stage img { max-width: none; }
.nai-shell-error { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--nai-border-soft); }
.nai-shell-error > .nai-error { flex: 1; }
.nai-warnings { grid-column: 1 / -1; }
.nai-selection-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 0; margin-bottom: 12px; border-block: 1px solid var(--nai-border-soft); font-size: 12px; }
.nai-gallery-selection { position: absolute; top: 8px; left: 8px; z-index: 3; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 4px; background: rgba(24,26,29,.85); cursor: pointer; }
.nai-gallery-selection input { margin: 0; width: 16px; height: 16px; }
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

/* ---- Atelier 0.18 visual layer: brand, library facets, image-forward gallery ---- */
.nai-root {
  --nai-accent-2: var(--dsw-alias-state-warn-primary, #b98438);
  --nai-gradient: linear-gradient(132deg, var(--nai-accent), color-mix(in srgb, var(--nai-accent) 52%, var(--nai-accent-2)));
  --nai-card-shadow: 0 1px 0 color-mix(in srgb, var(--nai-text) 5%, transparent), 0 14px 34px -26px color-mix(in srgb, #000 60%, transparent);
  --nai-card-shadow-hover: 0 2px 0 color-mix(in srgb, var(--nai-text) 7%, transparent), 0 22px 44px -26px color-mix(in srgb, #000 70%, transparent);
}
.nai-topbar {
  position: sticky; top: 0; z-index: 8;
  background:
    radial-gradient(120% 170% at 0% -20%, var(--nai-accent-soft), transparent 58%),
    color-mix(in srgb, var(--nai-bg) 92%, transparent);
  backdrop-filter: blur(10px);
}
.nai-brand-mark {
  width: 32px; height: 32px; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--nai-accent);
  background: color-mix(in srgb, var(--nai-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--nai-accent) 22%, var(--nai-border-soft));
}
.nai-brand-name { letter-spacing: .01em; }
.nai-tab-title { display: inline-flex; align-items: center; gap: 6px; }
.nai-tab-icon { color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary, currentColor)); }
.nai-guide-glyph { display: inline-flex; flex: none; }

/* Library: header, facets and controls */
.nai-lib-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.nai-lib-heading { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.nai-lib-heading .nai-section-title { margin: 0; font-size: 15px; letter-spacing: .01em; }
.nai-lib-count { font-size: 11px; color: var(--nai-faint); font-variant-numeric: tabular-nums; }
.nai-lib-head-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.nai-lib-searchrow { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.nai-lib-searchrow .nai-search { flex: 1 1 200px; }
.nai-lib-searchrow select { min-width: 108px; }
.nai-lib-kinds { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 8px; margin-bottom: 10px; scrollbar-width: thin; }
.nai-lib-kinds button {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 6px 11px; border-radius: 999px; border: 1px solid var(--nai-border-soft);
  background: transparent; color: var(--nai-dim); cursor: pointer; font-size: 12px; white-space: nowrap;
  transition: background .14s ease, color .14s ease, border-color .14s ease;
}
.nai-lib-kinds button:hover { background: var(--nai-hover); color: var(--nai-text); }
.nai-lib-kinds button.active {
  color: var(--nai-accent); border-color: color-mix(in srgb, var(--nai-accent) 42%, var(--nai-border));
  background: color-mix(in srgb, var(--nai-accent) 10%, transparent);
}
.nai-lib-chip-count {
  min-width: 17px; padding: 1px 5px; border-radius: 999px;
  background: color-mix(in srgb, var(--nai-text) 7%, transparent);
  color: var(--nai-faint); font-size: 10px; line-height: 15px; text-align: center; font-variant-numeric: tabular-nums;
}
.nai-lib-kinds button.active .nai-lib-chip-count { background: var(--nai-accent-soft); color: var(--nai-accent); }
.nai-lib-tags { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; color: var(--nai-faint); }
.nai-lib-tags > .nai-icon { color: var(--nai-faint); }
.nai-root .nai-tag.active { color: var(--nai-accent); border-color: color-mix(in srgb, var(--nai-accent) 45%, var(--nai-border)); background: var(--nai-accent-soft); }
.nai-lib-pager { display: flex; align-items: center; gap: 8px; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--nai-border-soft); }
.nai-lib-pager .faint, .nai-lib-card .faint, .nai-lib-usage { color: var(--nai-faint); }

/* Library cards */
.nai-lib-grid { grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr)); gap: 16px; }
/* Same adaptive masonry as the gallery, so an entry never crops its example art. */
.nai-lib-grid[data-layout="masonry"] { display: block; column-width: 236px; column-gap: 16px; }
.nai-lib-grid[data-layout="masonry"] .nai-lib-card { break-inside: avoid; margin: 0 0 16px; }
.nai-lib-card {
  position: relative; overflow: hidden;
  border-radius: 14px; border: 1px solid var(--nai-border-soft);
  background: linear-gradient(180deg, color-mix(in srgb, var(--nai-panel) 96%, var(--nai-text) 4%), var(--nai-panel));
  box-shadow: var(--nai-card-shadow);
  transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease;
}
.nai-lib-card:hover, .nai-lib-card:focus-within {
  transform: translateY(-2px); border-color: color-mix(in srgb, var(--nai-accent) 48%, var(--nai-border));
  box-shadow: var(--nai-card-shadow-hover);
}
.nai-lib-card .preview-box { aspect-ratio: 4 / 3; background: radial-gradient(120% 120% at 20% 0%, var(--nai-accent-soft), var(--nai-panel-2)); }
.nai-lib-grid[data-layout="masonry"] .nai-lib-card .preview-box { aspect-ratio: auto; min-height: 132px; }
.nai-lib-card .preview-box::after {
  content: ""; position: absolute; inset: 50% 0 0; pointer-events: none;
  background: linear-gradient(180deg, transparent, color-mix(in srgb, #000 38%, transparent));
}
.nai-lib-card .preview-box img { width: 100%; height: 100%; object-fit: cover; transition: transform .3s ease; }
.nai-lib-grid[data-layout="masonry"] .nai-lib-card .preview-box img {
  height: auto; max-height: 440px; object-fit: contain;
  background: var(--nai-panel-2);
}
.nai-lib-card:hover .preview-box img { transform: scale(1.025); }
.nai-lib-grid[data-layout="masonry"] .nai-lib-card:hover .preview-box img { transform: none; }
.nai-lib-card .preview-empty { position: relative; z-index: 1; gap: 6px; font-size: 11px; color: var(--nai-faint); }
.nai-lib-glyph {
  display: grid; place-items: center; width: 58px; height: 58px; border-radius: 18px;
  color: var(--nai-accent); background: color-mix(in srgb, var(--nai-accent) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--nai-accent) 18%, var(--nai-border-soft));
}
.nai-lib-kind, .nai-lib-examples {
  position: absolute; z-index: 2; bottom: 8px;
  padding: 2px 8px; border-radius: 999px;
  background: rgba(18, 20, 24, .78); color: #fff; border: 1px solid rgba(255,255,255,.16);
  font-size: 10px; line-height: 17px; backdrop-filter: blur(6px);
}
.nai-lib-kind { left: 8px; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nai-lib-examples { right: 8px; display: inline-flex; align-items: center; gap: 3px; }
.nai-lib-favorite {
  position: absolute; z-index: 5; top: 8px; right: 8px;
  width: 28px; height: 28px; display: grid; place-items: center; padding: 0;
  border-radius: 8px; border: 1px solid rgba(255,255,255,.18);
  background: rgba(18, 20, 24, .72); color: rgba(255,255,255,.8); cursor: pointer;
  backdrop-filter: blur(6px);
}
.nai-lib-favorite:hover { color: #fff; background: rgba(18, 20, 24, .9); }
.nai-lib-favorite.active { color: #1b1c1f; background: var(--nai-warn); border-color: transparent; }
.nai-lib-favorite:disabled { opacity: .5; cursor: wait; }
.nai-library-selection { top: 8px; left: 8px; z-index: 5; }
.nai-lib-card .content { padding: 12px; gap: 8px; }
.nai-lib-card .name { font-size: 14px; letter-spacing: .01em; }
.nai-lib-revision { padding: 0 5px; font-size: 9px; color: var(--nai-faint); }
.nai-lib-card .prompt-preview { min-height: 0; max-height: 36px; -webkit-line-clamp: 2; line-height: 1.55; font-size: 11px; }
.nai-lib-tagline, .nai-lib-branches { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.nai-lib-tagline .nai-tag, .nai-lib-branches .nai-pill { padding: 1px 6px; font-size: 10px; }
.nai-lib-branches .nai-pill { color: var(--nai-accent); cursor: pointer; background: var(--nai-accent-soft); border-color: color-mix(in srgb, var(--nai-accent) 20%, var(--nai-border-soft)); }
.nai-lib-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; color: var(--nai-faint); font-size: 10px; font-variant-numeric: tabular-nums; }
.nai-lib-card .actions { padding-top: 9px; gap: 6px; }
.nai-lib-card .actions .nai-btn.primary { flex: 1 1 auto; background: var(--nai-gradient); border-color: transparent; box-shadow: 0 6px 16px -12px color-mix(in srgb, var(--nai-accent) 90%, transparent); }
.nai-lib-card-tools { display: flex; align-items: center; gap: 4px; }
.nai-lib-card-tools .nai-btn { padding-inline: 6px; }

/* Library editor additions */
.nai-lib-editor-meta { margin-top: 10px; gap: 12px; }
.nai-lib-editor-side { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; }
.nai-lib-usage { font-size: 10px; }
.nai-dropzone {
  min-height: 74px; padding: 10px; border-radius: 10px;
  border: 1px dashed var(--nai-border); background: color-mix(in srgb, var(--nai-panel-2) 55%, transparent);
}
.nai-dropzone-hint { color: var(--nai-faint); font-size: 11px; padding: 20px 4px; }
.nai-dropzone:has(img) { min-height: 0; }
.nai-cover-badge, .nai-cover-action {
  position: absolute; left: 5px; bottom: 5px; z-index: 2;
  padding: 2px 6px; border-radius: 4px; font-size: 10px; line-height: 15px;
  color: #fff; background: rgba(18, 20, 24, .8); border: 1px solid rgba(255,255,255,.16);
}
.nai-cover-action { cursor: pointer; opacity: 0; transition: opacity .12s ease; }
.nai-dropzone span:hover .nai-cover-action, .nai-cover-action:focus-visible { opacity: 1; }
@media (hover: none) { .nai-cover-action { opacity: .9; } }
.nai-cover-badge { background: var(--nai-accent); border-color: transparent; color: var(--nai-accent-foreground); }

/* Gallery cards: image first, quiet content block, actions on hover */
.nai-gallery { gap: 16px; }
.nai-gallery .cell {
  border-radius: 14px; background: linear-gradient(180deg, color-mix(in srgb, var(--nai-panel) 96%, var(--nai-text) 4%), var(--nai-panel));
  box-shadow: var(--nai-card-shadow);
  transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease;
}
.nai-gallery .cell:hover, .nai-gallery .cell:focus-within {
  transform: translateY(-2px); border-color: color-mix(in srgb, var(--nai-accent) 48%, var(--nai-border));
  box-shadow: var(--nai-card-shadow-hover);
}
.nai-gallery .cell .img-wrap { background: radial-gradient(120% 120% at 20% 0%, var(--nai-accent-soft), var(--nai-panel-2)); }
.nai-gallery .cell .img-wrap img { transition: transform .35s ease; }
.nai-gallery .cell:hover .img-wrap img { transform: scale(1.015); }
.nai-card-actions {
  position: absolute; right: 8px; bottom: 8px; z-index: 3;
  display: flex; align-items: center; gap: 6px;
  opacity: 0; pointer-events: none; transition: opacity .16s ease;
}
.nai-gallery .cell:hover .nai-card-actions, .nai-gallery .cell:focus-within .nai-card-actions { opacity: 1; pointer-events: auto; }
.nai-card-action {
  width: 30px; height: 30px; display: grid; place-items: center; padding: 0;
  border-radius: 999px; border: 1px solid rgba(255,255,255,.24);
  background: rgba(18, 20, 24, .68); color: #fff; cursor: pointer; backdrop-filter: blur(8px);
}
.nai-card-action:hover { background: rgba(18,20,24,.92); transform: scale(1.05); }
.nai-card-action:disabled { opacity: .45; cursor: not-allowed; }
.nai-status { text-transform: none; }
.nai-status.failed { color: #ffb4b8; }
.nai-status.running, .nai-status.queued { color: #bcd3ff; }
.nai-gallery .content { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 12px; min-width: 0; }
.nai-card-prompt {
  font-size: 12px; line-height: 1.5; color: var(--nai-text);
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere;
}
.nai-card-meta { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; font-size: 10px; color: var(--nai-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
.nai-card-op { color: var(--nai-dim); }
.nai-card-spacer { flex: 1; }
.nai-card-anlas { color: var(--nai-accent); font-weight: 600; }
.nai-model-pill { padding: 0 5px; font-size: 9px; }
.nai-gallery-hint {
  display: flex; align-items: flex-start; gap: 7px; margin: -6px 0 14px;
  padding: 8px 10px; border-radius: 8px; font-size: 11px; line-height: 1.6;
  color: var(--nai-dim); background: var(--nai-accent-soft); border: 1px solid color-mix(in srgb, var(--nai-accent) 16%, var(--nai-border-soft));
}
.nai-gallery-hint > .nai-icon { margin-top: 1px; color: var(--nai-accent); }

/* Loading skeletons and rich empty states */
.nai-card-skeleton {
  border-radius: 14px; overflow: hidden; padding: 0 0 12px;
  border: 1px solid var(--nai-border-soft); background: var(--nai-panel);
}
.skeleton-block { background: linear-gradient(90deg, var(--nai-panel-2) 20%, color-mix(in srgb, var(--nai-text) 7%, var(--nai-panel-2)) 38%, var(--nai-panel-2) 56%); background-size: 200% 100%; animation: nai-shimmer 1.5s linear infinite; border-radius: 6px; }
.skeleton-cover { aspect-ratio: 4 / 5; border-radius: 0; }
.nai-lib-card.nai-skeleton .skeleton-cover { aspect-ratio: 4 / 3; }
.skeleton-line { height: 12px; margin: 10px 12px 0; }
.skeleton-line.short { width: 55%; }
@keyframes nai-shimmer { from { background-position: 200% 0; } to { background-position: -40% 0; } }
.nai-empty-rich { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 52px 16px; }
.nai-empty-rich strong { color: var(--nai-text); font-size: 14px; }
.nai-empty-rich p { margin: 0 0 6px; max-width: 42ch; color: var(--nai-faint); font-size: 12px; line-height: 1.7; }
.nai-empty-glyph {
  display: grid; place-items: center; width: 66px; height: 66px; margin-bottom: 4px; border-radius: 22px;
  color: var(--nai-accent); background: var(--nai-accent-soft);
  border: 1px solid color-mix(in srgb, var(--nai-accent) 16%, var(--nai-border-soft));
}
@container atelier (max-width: 620px) {
  .nai-lib-head { align-items: flex-start; }
  .nai-lib-searchrow { gap: 8px; }
  .nai-lib-searchrow .nai-search { flex-basis: 100%; }
  .nai-lib-grid { gap: 12px; }
  .nai-gallery { gap: 12px; }
  .nai-gallery[data-layout="columns"], .nai-gallery[data-layout="columns"] > .nai-gallery-column { gap: 12px; }
  .nai-lib-grid[data-layout="masonry"] { column-gap: 12px; }
  .nai-lib-grid[data-layout="masonry"] .nai-lib-card { margin-bottom: 12px; }
  .nai-card-actions { display: none; }
}
`
