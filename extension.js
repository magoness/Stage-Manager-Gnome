import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const BASE_GRID_W     = 158;
const BASE_GRID_H     = 89;
const BASE_ICON_SIZE  = 42;
const ICON_OVL        = 20;
const PAD_H           = 12;
// R is now computed dynamically per monitor in _computeGeo()
const MAX_ANGLE       = 52;
const SCROLL_FRICTION = 0.82;
const SCROLL_MIN_VEL  = 0.005;
const DRAG_THRESHOLD  = 18;
const GHOST_SIZE      = 100;

const KEYBINDINGS = [
    'keybinding-toggle',
    'keybinding-next',
    'keybinding-prev',
    'keybinding-activate',
    'keybinding-close',
];

export default class StageArc extends Extension {

    enable() {
        this._monitor     = this._pickMonitor();
        this._isVisible   = false;
        this._persistMode = false;
        this._hideTimer   = null;
        this._pollId      = null;
        this._persistId   = null;
        this._focusSig    = null;
        this._refreshTo   = null;
        this._settingsSig = null;
        this._physicsId   = null;
        this._groups      = [];
        this._offset      = 0;
        this._velocity    = 0;
        this._containers  = [];
        this._windowMap   = new Map();
        this._groupStates = new Map();
        this._panel       = null;
        this._edge        = null;

        this._overviewShowSig = null;
        this._overviewHideSig = null;
        this._monitorSig      = null;
        this._dragging      = false;
        this._dragGroup     = null;
        this._dragGhost     = null;
        this._dragStartX    = 0;
        this._dragStartY    = 0;
        this._dragCandidate = null;

        this._mergeMap      = new Map();
        this._vertOffset    = 0;   // vertical mode scroll offset (index float)
        this._vertVelocity  = 0;

        this._orderMap = new Map(); // group_key → order index

        this._settings = this.getSettings();
        this._loadMergeMap();
        this._loadOrderMap();
        this._loadConfig();
        this._buildUI();
        this._startPolls();
        this._setupKeybindings();

        this._focusSig = global.display.connect('notify::focus-window', () => {
            this._trackFocus();
            this._redraw();
        });

        this._overviewShowSig = Main.overview.connect('showing', () => {
            this._cancelDrag();
            if (this._isVisible) this._hidePanel();
        });
        this._overviewHideSig = Main.overview.connect('hidden', () => {
            this._checkPersistence();
        });

        this._monitorSig = Main.layoutManager.connect('monitors-changed', () => {
            this._monitor = this._pickMonitor();
            this._rebuild();
        });

        this._settingsSig = this._settings.connect('changed', (_s, key) => {
            if (key === 'order-map') {
                this._loadOrderMap();
                this._refresh();
            } else if (key === 'merge-map') {
                this._loadMergeMap();
                this._refresh();
            } else if (KEYBINDINGS.includes(key)) {
                this._teardownKeybindings();
                this._setupKeybindings();
            } else {
                this._rebuild();
            }
        });

        this._refresh();
    }

    disable() {
        this._cancelDrag();
        this._teardownKeybindings();

        if (this._overviewShowSig) { Main.overview.disconnect(this._overviewShowSig); this._overviewShowSig = null; }
        if (this._overviewHideSig)  { Main.overview.disconnect(this._overviewHideSig);  this._overviewHideSig = null; }
        if (this._monitorSig)       { Main.layoutManager.disconnect(this._monitorSig);  this._monitorSig      = null; }
        if (this._settingsSig) { this._settings.disconnect(this._settingsSig); this._settingsSig = null; }
        if (this._focusSig)    { global.display.disconnect(this._focusSig);    this._focusSig = null; }
        if (this._pollId)      { GLib.source_remove(this._pollId);    this._pollId = null; }
        if (this._persistId)   { GLib.source_remove(this._persistId); this._persistId = null; }
        if (this._refreshTo)   { GLib.source_remove(this._refreshTo); this._refreshTo = null; }
        if (this._hideTimer)   { GLib.source_remove(this._hideTimer); this._hideTimer = null; }
        if (this._physicsId)   { GLib.source_remove(this._physicsId); this._physicsId = null; }

        if (this._edge)  { this._edge.destroy();  this._edge = null; }
        if (this._panel) { this._panel.destroy(); this._panel = null; }

        this._settings = null;
    }

    // ── Merge persistence ─────────────────────────────────────────────────────

    _loadMergeMap() {
        try {
            const raw = this._settings.get_string('merge-map');
            const obj = JSON.parse(raw);
            this._mergeMap = new Map(Object.entries(obj));
        } catch (_) {
            this._mergeMap = new Map();
        }
    }

    _saveMergeMap() {
        const obj = Object.fromEntries(this._mergeMap);
        this._settings.set_string('merge-map', JSON.stringify(obj));
    }

    _loadOrderMap() {
        try {
            const raw = this._settings.get_string('order-map');
            const obj = JSON.parse(raw);
            this._orderMap = new Map(Object.entries(obj).map(([k, v]) => [k, Number(v)]));
        } catch (_) {
            this._orderMap = new Map();
        }
    }

    _saveOrderMap() {
        const obj = Object.fromEntries(this._orderMap);
        this._settings.set_string('order-map', JSON.stringify(obj));
    }

    _mergeApps(sourceAppId, targetAppId) {
        const targetKey = this._mergeMap.get(targetAppId) ?? targetAppId;
        const groupMembers = new Set([targetKey]);
        this._mergeMap.forEach((gKey, aId) => {
            if (gKey === targetKey) groupMembers.add(aId);
        });
        groupMembers.add(sourceAppId);
        const newKey = [...groupMembers].sort().join('|');
        groupMembers.forEach(aId => this._mergeMap.set(aId, newKey));
        this._saveMergeMap();
    }

    _unmergeApp(appId) {
        this._mergeMap.delete(appId);

        // Rebuild: for each remaining gKey, count how many apps still reference it
        const counts = new Map();
        this._mergeMap.forEach(gKey => counts.set(gKey, (counts.get(gKey) ?? 0) + 1));

        // Remove apps whose group now only has one member — they don't need a merge entry
        const toDelete = [];
        this._mergeMap.forEach((gKey, aId) => {
            if ((counts.get(gKey) ?? 0) <= 1) toDelete.push(aId);
        });
        toDelete.forEach(aId => this._mergeMap.delete(aId));

        this._saveMergeMap();
    }

    // ── Config ────────────────────────────────────────────────────────────────

    _loadConfig() {
        const s   = this._settings;
        const pct = s.get_int('thumbnail-size') / 100;

        this._gW         = Math.round(BASE_GRID_W * pct);
        this._gH         = Math.round(BASE_GRID_H * pct);
        this._iS         = Math.round(BASE_ICON_SIZE * pct);
        this._panelSize  = Math.ceil(this._gW * 1.12 + PAD_H * 2);
        this._cxOffset   = PAD_H + this._gW / 2;
        this._angleStep  = s.get_int('angle-step');
        this._hideDelay  = s.get_int('hide-delay');
        this._scrollStep = this._mapSpeed(s.get_int('scroll-speed'));
        this._pos        = s.get_string('panel-position');
        this._layoutMode = s.get_string('layout-mode');
        this._persistEnabled = s.get_boolean('persistent-mode');
        try { this._vertSpacing = s.get_int('vert-spacing'); } catch (_) { this._vertSpacing = 6; }
        this._geo        = this._computeGeo();
    }

    _mapSpeed(val) {
        return 0.01 + (val - 1) * (0.15 - 0.01) / 19;
    }

    _computeGeo() {
        const mon  = this._monitor;
        const PS   = this._panelSize;
        const CX   = this._cxOffset;

        const monIdx = Main.layoutManager.monitors.indexOf(mon);
        const wa     = Main.layoutManager.getWorkAreaForMonitor(monIdx >= 0 ? monIdx : 0);

        // Arc radius scales with workarea so proportions hold on any resolution.
        // Use the same formula for left and right so the arc looks identical on both sides.
        const R_side   = Math.round(wa.height * 0.48);
        const R_bottom = Math.round(wa.width  * 0.46);

        // Center of workarea, relative to monitor origin
        const waCY = wa.y - mon.y + wa.height / 2;
        const waCX = wa.x - mon.x + wa.width  / 2;

        // Hotspot strip length: 35% of the shorter workarea dimension
        const hotLen = Math.round(Math.min(wa.height, wa.width) * 0.35);

        // Lateral panels: start at wa.y (below top bar) with wa.height so they
        // never overlap the shell bar and are never clipped at the bottom.
        const latY  = wa.y - mon.y;   // panel top, relative to mon.y
        const latH  = wa.height;

        switch (this._pos) {
            case 'right':
                return {
                    panelX: mon.x + mon.width,        panelY: mon.y + latY,
                    panelW: PS,                        panelH: latH,
                    visX:   mon.x + mon.width - PS,   visY:   mon.y + latY,
                    hidX:   mon.x + mon.width,         hidY:   mon.y + latY,
                    edgeX:  mon.x + mon.width - 4,
                    edgeY:  mon.y + waCY - hotLen / 2,
                    edgeW: 4, edgeH: hotLen,
                    // Arc center is off the right edge; items curve leftward into the panel
                    arcCX: PS - CX + R_side,
                    arcCY: waCY - latY,   // relative to panel top (which now starts at latY)
                    centerAngle: 180,
                    arcR: R_side,
                };
            case 'bottom':
                return {
                    panelX: mon.x,                    panelY: mon.y + mon.height,
                    panelW: mon.width,                 panelH: PS,
                    visX:   mon.x,                    visY:   mon.y + mon.height - PS,
                    hidX:   mon.x,                    hidY:   mon.y + mon.height,
                    edgeX:  mon.x + waCX - hotLen / 2,
                    edgeY:  mon.y + mon.height - 4,
                    edgeW: hotLen, edgeH: 4,
                    arcCX: waCX,
                    arcCY: PS - CX + R_bottom,
                    centerAngle: -90,
                    arcR: R_bottom,
                };
            default: // left
                return {
                    panelX: mon.x - PS,  panelY: mon.y + latY,
                    panelW: PS,          panelH: latH,
                    visX:   mon.x,       visY:   mon.y + latY,
                    hidX:   mon.x - PS,  hidY:   mon.y + latY,
                    edgeX:  mon.x,
                    edgeY:  mon.y + waCY - hotLen / 2,
                    edgeW: 4, edgeH: hotLen,
                    arcCX: CX - R_side,
                    arcCY: waCY - latY,   // relative to panel top
                    centerAngle: 0,
                    arcR: R_side,
                };
        }
    }

    // ── UI ────────────────────────────────────────────────────────────────────

    _buildUI() {
        const geo = this._geo;

        this._panel = new St.Widget({
            reactive: true,
            clip_to_allocation: true,
            style: 'background-color: transparent;',
            width: geo.panelW,
            height: geo.panelH,
        });
        this._panel.set_position(geo.panelX, geo.panelY);
        Main.layoutManager.addChrome(this._panel, { trackFullscreen: true });

        this._edge = new St.Widget({
            reactive: true,
            style: 'background-color: rgba(255,255,255,0.01);',
            width: geo.edgeW,
            height: geo.edgeH,
        });
        this._edge.set_position(geo.edgeX, geo.edgeY);
        Main.layoutManager.addChrome(this._edge);

        this._edge.connect('enter-event',  () => { if (!this._isVisible) this._showPanel(); });
        this._panel.connect('enter-event', () => { if (!this._dragging) this._cancelHide(); });
        this._panel.connect('leave-event', () => { if (this._isVisible && !this._dragging) this._startHide(); });

        this._panel.connect('scroll-event', (_a, event) => {
            if (this._dragging) return Clutter.EVENT_STOP;
            if (this._layoutMode === 'vertical') {
                const dir = event.get_scroll_direction();
                if (dir === Clutter.ScrollDirection.DOWN) this._scrollVertical(1);
                else if (dir === Clutter.ScrollDirection.UP) this._scrollVertical(-1);
                return Clutter.EVENT_STOP;
            }
            this._handleScroll(event);
            return Clutter.EVENT_STOP;
        });
    }

    _destroyUI() {
        this._cancelHide();
        if (this._edge)  { this._edge.destroy();  this._edge = null; }
        if (this._panel) { this._panel.destroy(); this._panel = null; }
    }

    _rebuild() {
        const wasVisible = this._isVisible;
        this._isVisible = false;
        this._monitor = Main.layoutManager.primaryMonitor;
        this._destroyUI();
        this._loadConfig();
        this._buildUI();
        if (wasVisible) this._showPanel();
        else this._refresh();
    }

    // ── Polls ─────────────────────────────────────────────────────────────────

    _startPolls() {
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 32, () => {
            const [px, py, mask] = global.get_pointer();
            const mon  = this._monitor;
            const held = !!(mask & Clutter.ModifierType.BUTTON1_MASK);

            // Skip all work when panel is hidden and nothing interactive is pending
            const idle = !this._isVisible && !this._dragging && !this._dragCandidate;
            if (!idle || held) {
                if (!this._dragging) {
                    let hot = false;
                    if      (this._pos === 'bottom') hot = py >= mon.y + mon.height - 8;
                    else if (this._pos === 'right')  hot = px >= mon.x + mon.width - 8;
                    else                             hot = px <= mon.x + 8;
                    if (held && hot && !this._isVisible) this._showPanel();
                }

                if (this._dragCandidate && held) {
                    const dx = px - this._dragStartX;
                    const dy = py - this._dragStartY;
                    if (Math.sqrt(dx*dx + dy*dy) > DRAG_THRESHOLD) {
                        this._startDrag(this._dragCandidate);
                        this._dragCandidate = null;
                    }
                } else if (this._dragCandidate && !held) {
                    this._dragCandidate = null;
                }

                if (this._dragging) {
                    if (held) {
                        this._updateGhost(px, py);
                    } else {
                        this._commitDrag(px, py);
                    }
                }
            }

            return GLib.SOURCE_CONTINUE;
        });

        this._persistId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._checkPersistence();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ── Drag ──────────────────────────────────────────────────────────────────

    _startDrag(group) {
        this._dragging  = true;
        this._dragGroup = group;
        this._cancelHide();

        const ghost = new St.Widget({
            width: GHOST_SIZE, height: GHOST_SIZE,
            opacity: 220,
            style: 'background-color: rgba(30,30,30,0.88); border-radius: 18px; border: 2px solid rgba(255,255,255,0.28);',
        });
        ghost.set_pivot_point(0.5, 0.5);

        const icon = new St.Widget({ width: 48, height: 48 });
        icon.add_child(group.app.create_icon_texture(48));
        icon.set_position(GHOST_SIZE / 2 - 24, GHOST_SIZE / 2 - 24);
        ghost.add_child(icon);

        if (group.apps.length > 1) {
            const icon2 = new St.Widget({ width: 28, height: 28 });
            icon2.add_child(group.apps[1].create_icon_texture(28));
            icon2.set_position(GHOST_SIZE / 2 + 8, GHOST_SIZE / 2 + 8);
            ghost.add_child(icon2);
        }

        this._dragGhost = ghost;
        Main.uiGroup.add_child(ghost);
        this._updateGhost(this._dragStartX, this._dragStartY);

        this._containers.forEach(c => {
            if (c._groupRef === group)
                c.ease({ opacity: 60, duration: 150 });
        });
    }

    _updateGhost(px, py) {
        if (!this._dragGhost) return;
        this._dragGhost.set_position(px - GHOST_SIZE / 2, py - GHOST_SIZE / 2);
    }

    _commitDrag(px, py) {
        if (!this._dragging) return;
        const group = this._dragGroup;
        this._cancelDrag();

        const mon = this._monitor;
        const PS  = this._panelSize;
        let outside = false;
        if      (this._pos === 'right')  outside = px < mon.x + mon.width - PS - 20;
        else if (this._pos === 'bottom') outside = py < mon.y + mon.height - PS - 20;
        else                             outside = px > mon.x + PS + 20;

        if (outside) {
            this._mergeIntoActive(group);
        } else {
            this._reorderGroup(group, px, py);
        }
    }

    _reorderGroup(group, px, py) {
        if (this._groups.length < 2) return;

        const sourceIdx = this._groups.indexOf(group);
        if (sourceIdx === -1) return;

        // Find nearest group by proximity of cursor to each container center
        let targetIdx = sourceIdx;
        let minDist   = Infinity;

        this._containers.forEach((c, i) => {
            const cx = c.get_x() + c.width  / 2;
            const cy = c.get_y() + c.height / 2;
            // For panel position, weight the relevant axis more
            let dist;
            if (this._pos === 'bottom') dist = Math.abs(px - cx);
            else                        dist = Math.abs(py - cy);
            if (dist < minDist) { minDist = dist; targetIdx = i; }
        });

        if (targetIdx === sourceIdx) return;

        // Rebuild order: remove source, insert at target
        const ordered = [...this._groups];
        const [moved]  = ordered.splice(sourceIdx, 1);
        ordered.splice(targetIdx, 0, moved);

        // Save new order
        this._orderMap.clear();
        ordered.forEach((g, i) => this._orderMap.set(g.key, i));
        this._saveOrderMap();

        this._refresh();
    }

    _cancelDrag() {
        this._dragging      = false;
        this._dragGroup     = null;
        this._dragCandidate = null;

        if (this._dragGhost) { this._dragGhost.destroy(); this._dragGhost = null; }

        this._containers.forEach(c => c.ease({ opacity: c._baseOpacity ?? 255, duration: 150 }));
    }

    _mergeIntoActive(sourceGroup) {
        const focused = global.display.get_focus_window();
        if (!focused) return;
        const tracker   = Shell.WindowTracker.get_default();
        const activeApp = tracker.get_window_app(focused);
        if (!activeApp) return;

        const activeAppId = activeApp.get_id();
        const sourceAppId = sourceGroup.app.get_id();
        if (activeAppId === sourceAppId) return;

        this._mergeApps(sourceAppId, activeAppId);

        sourceGroup.windows.forEach(win => {
            if (win.minimized) win.unminimize();
            win.raise();
        });

        this._hidePanel();
        this._refresh();
    }

    // ── Keybindings ───────────────────────────────────────────────────────────

    _setupKeybindings() {
        this._bindKey('keybinding-toggle', () => {
            this._isVisible ? this._hidePanel() : this._showPanel();
        });
        this._bindKey('keybinding-next', () => {
            this._scrollTo(Math.round(this._offset) + 1);
        });
        this._bindKey('keybinding-prev', () => {
            this._scrollTo(Math.round(this._offset) - 1);
        });
        this._bindKey('keybinding-activate', () => {
            const idx = Math.round(this._offset);
            if (this._groups[idx]) {
                if (!this._isVisible) this._showPanel();
                this._activateGroup(this._groups[idx]);
            }
        });
        this._bindKey('keybinding-close', () => {
            const idx = Math.round(this._offset);
            const grp = this._groups[idx];
            if (grp?.windows[0]) {
                grp.windows[0].delete(global.get_current_time());
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                    this._refresh();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    }

    _bindKey(settingKey, callback) {
        const binding = this._settings.get_strv(settingKey)[0];
        if (!binding || binding === '') return;
        try {
            Main.wm.addKeybinding(
                settingKey, this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                callback
            );
        } catch (e) {
            console.error(`[stage-arc] keybinding error (${settingKey}):`, e.message);
        }
    }

    _teardownKeybindings() {
        KEYBINDINGS.forEach(key => { try { Main.wm.removeKeybinding(key); } catch (_) {} });
    }

    // ── Scroll physics ────────────────────────────────────────────────────────

    _handleScroll(event) {
        const dir      = event.get_scroll_direction();
        const isBottom = this._pos === 'bottom';

        if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            const delta = isBottom ? dx : dy;
            if (Math.abs(delta) > 0.01) { this._velocity += delta * this._scrollStep; this._startPhysics(); }
        } else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) {
            this._velocity += this._scrollStep; this._startPhysics();
        } else if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) {
            this._velocity -= this._scrollStep; this._startPhysics();
        }
    }

    _startPhysics() {
        if (this._physicsId) return;
        this._physicsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            this._offset   += this._velocity;
            this._velocity *= SCROLL_FRICTION;
            const max = Math.max(0, this._groups.length - 1);
            if (this._offset < 0)   { this._offset = 0;   this._velocity = 0; }
            if (this._offset > max) { this._offset = max; this._velocity = 0; }
            this._redraw();
            if (Math.abs(this._velocity) < SCROLL_MIN_VEL) {
                this._velocity = 0; this._physicsId = null; return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _scrollTo(targetIdx, onComplete) {
        if (this._physicsId) { GLib.source_remove(this._physicsId); this._physicsId = null; }
        this._velocity = 0;
        targetIdx = Math.max(0, Math.min(targetIdx, this._groups.length - 1));
        const start  = this._offset;
        const frames = Math.max(8, Math.round(Math.abs(targetIdx - start) * 12));
        let   frame  = 0;
        this._physicsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            frame++;
            this._offset = start + (targetIdx - start) * (1 - Math.pow(1 - frame / frames, 3));
            this._redraw();
            if (frame >= frames) {
                this._offset = targetIdx; this._physicsId = null; this._redraw(); onComplete?.();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ── Data ──────────────────────────────────────────────────────────────────

    _refresh() {
        if (this._refreshTo) GLib.source_remove(this._refreshTo);
        this._refreshTo = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._refreshTo = null;
            this._buildGroups();
            this._redraw();
            return GLib.SOURCE_REMOVE;
        });
    }

    _buildGroups() {
        const workspace = global.workspace_manager.get_active_workspace();
        const tracker   = Shell.WindowTracker.get_default();
        const byApp     = {};

        workspace.list_windows().forEach(win => {
            if (win.skip_taskbar || !win.get_compositor_private() || win.is_attached_dialog()) return;
            const app = tracker.get_window_app(win);
            if (!app) return;
            const id = app.get_id();
            if (!byApp[id]) byApp[id] = { app, windows: [] };
            byApp[id].windows.push(win);
        });

        const byGroup = {};
        Object.entries(byApp).forEach(([appId, { app, windows }]) => {
            const groupKey = this._mergeMap.get(appId) ?? appId;
            if (!byGroup[groupKey]) byGroup[groupKey] = { appIds: [], apps: [], windows: [], key: groupKey };
            byGroup[groupKey].appIds.push(appId);
            byGroup[groupKey].apps.push(app);
            byGroup[groupKey].windows.push(...windows);
        });

        this._groups = Object.values(byGroup).map(g => {
            g.appIds.sort();
            g.app = g.apps[0];
            return g;
        });

        // Purge stale _groupStates entries for apps no longer on the workspace
        const liveAppIds = new Set(Object.keys(byApp));
        this._groupStates.forEach((_, id) => {
            if (!liveAppIds.has(id)) this._groupStates.delete(id);
        });

        // Sort by order-map; unordered groups go to the end in stable order
        this._groups.sort((a, b) => {
            const oa = this._orderMap.has(a.key) ? this._orderMap.get(a.key) : 99999;
            const ob = this._orderMap.has(b.key) ? this._orderMap.get(b.key) : 99999;
            return oa - ob;
        });

        this._offset = Math.max(0, Math.min(this._offset, this._groups.length - 1));

        // Promote the currently focused window to index 0 of its group's window list
        // so the stack thumbnail always shows the active window on top
        const focused = global.display.get_focus_window();
        if (focused) {
            this._groups.forEach(g => {
                const fi = g.windows.indexOf(focused);
                if (fi > 0) {
                    g.windows.splice(fi, 1);
                    g.windows.unshift(focused);
                    // Keep primary app in sync with front window
                    const tracker = Shell.WindowTracker.get_default();
                    const fApp    = tracker.get_window_app(focused);
                    if (fApp) g.app = fApp;
                }
            });
        }
    }

    // ── Render ────────────────────────────────────────────────────────────────

    _redraw() {
        if (this._layoutMode === 'vertical') { this._redrawVertical(); return; }
        if (!this._panel) return;
        // Cancel any pending fan/close timers before destroying children
        this._containers.forEach(c => {
            const g = c._grid;
            if (g?._fanTimer)   { GLib.source_remove(g._fanTimer);   g._fanTimer   = null; }
            if (g?._closeTimer) { GLib.source_remove(g._closeTimer); g._closeTimer = null; }
        });
        this._panel.destroy_all_children();
        this._containers = [];
        this._windowMap.clear();
        if (this._groups.length === 0) return;

        const geo = this._geo;

        this._groups.forEach((group, idx) => {
            const relIdx   = idx - this._offset;
            const angleDeg = geo.centerAngle + relIdx * this._angleStep;
            const angleRad = angleDeg * Math.PI / 180;

            if (Math.abs(relIdx * this._angleStep) > MAX_ANGLE + this._angleStep) return;

            const arcR   = geo.arcR;
            const itemCX = geo.arcCX + arcR * Math.cos(angleRad);
            const itemCY = geo.arcCY + arcR * Math.sin(angleRad);

            const dist  = Math.abs(relIdx);
            const scale = Math.pow(0.78, dist);
            const alpha = 255;

            const sW   = Math.round(this._gW * scale);
            const sH   = Math.round(this._gH * scale);
            const sI   = Math.round(this._iS * scale);
            const sOvl = Math.round(ICON_OVL * scale);
            const sP   = Math.round(PAD_H * scale);
            const totH = sH + sI - sOvl;

            const baseX = Math.round(itemCX - sW / 2 - sP);
            const baseY = Math.round(itemCY - totH / 2);

            const container = new St.Widget({
                reactive: true, track_hover: true,
                opacity: alpha,
                width: sW + sP * 2,
                height: totH,
            });
            container.set_pivot_point(0.5, 0.5);
            container.set_position(baseX, baseY);
            container._baseX       = baseX;
            container._baseY       = baseY;
            container._baseOpacity = alpha;
            container._groupRef    = group;

            const grid = this._buildGrid(group, sW, sH, scale);
            grid.set_position(sP, 0);
            container.add_child(grid);
            container._grid = grid;

            container._dim = null; // dims are now per-cell inside grid._dimCells

            this._buildIconRow(container, group, sW, sI, sOvl, sP, scale, grid);

            container.connect('notify::hover', () => {
                if (container.hover) {
                    this._containers.forEach(c => {
                        const isThis = c === container;
                        c.ease({ scale_x: isThis ? 1.08 : 0.95, scale_y: isThis ? 1.08 : 0.95,
                            duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                    });
                    // Fan stack after 350ms hold
                    const g = container._grid;
                    if (g && !g._fanned && !g._fanTimer) {
                        g._fanTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                            g._fanTimer = null;
                            if (container.hover) {
                                const { shift, isBottom } = this._positionFan(g);
                                this._containers.forEach(c => {
                                    if (c === container) return;
                                    const after = isBottom
                                        ? c._baseX > container._baseX
                                        : c._baseY > container._baseY;
                                    c.ease({
                                        x: c._baseX + (after && isBottom  ? shift : 0),
                                        y: c._baseY + (after && !isBottom ? shift : 0),
                                        scale_x: 0.92, scale_y: 0.92,
                                        duration: 280, mode: Clutter.AnimationMode.EASE_OUT_BACK,
                                    });
                                });
                            }
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                } else {
                    // Cancel pending fan; start grace timer before collapsing
                    const g = container._grid;
                    if (g?._fanTimer) { GLib.source_remove(g._fanTimer); g._fanTimer = null; }
                    if (g?._fanned) {
                        if (g._closeTimer) { GLib.source_remove(g._closeTimer); g._closeTimer = null; }
                        g._closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 470, () => {
                            g._closeTimer = null;
                            if (!container.hover) {
                                this._positionStack(g);
                                this._containers.forEach(c => {
                                    c.ease({ x: c._baseX, y: c._baseY, scale_x: 1.0, scale_y: 1.0,
                                        duration: 240, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                                });
                            }
                            return GLib.SOURCE_REMOVE;
                        });
                    }

                    if (!this._containers.some(c => c.hover)) {
                        this._containers.forEach(c => {
                            c.ease({ x: c._baseX, y: c._baseY, scale_x: 1.0, scale_y: 1.0,
                                duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                        });
                    }
                }
            });

            container.connect('button-press-event', (_a, event) => {
                if (event.get_button() === 3 && group.appIds.length > 1) {
                    group.appIds.forEach(id => this._unmergeApp(id));
                    this._refresh();
                    return Clutter.EVENT_STOP;
                }
                if (event.get_button() === 1) {
                    const [px, py] = global.get_pointer();
                    this._dragStartX    = px;
                    this._dragStartY    = py;
                    this._dragCandidate = group;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            container.connect('button-release-event', (_a, event) => {
                if (this._dragging) return Clutter.EVENT_STOP;
                const btn = event.get_button();

                // Middle-click: close front window (only when stacked; cards handle it when fanned)
                if (btn === 2) {
                    if (!container._grid?._fanned) {
                        const win = group.windows[0];
                        if (win) {
                            win.delete(global.get_current_time());
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { this._refresh(); return GLib.SOURCE_REMOVE; });
                        }
                    }
                    return Clutter.EVENT_STOP;
                }

                if (btn !== 1) return Clutter.EVENT_PROPAGATE;
                this._dragCandidate = null;
                if (idx !== Math.round(this._offset))
                    this._scrollTo(idx, () => this._activateGroup(group));
                else
                    this._activateGroup(group);
                return Clutter.EVENT_STOP;
            });

            this._containers.push(container);
            this._panel.add_child(container);
        });
    }

    // ── Icon row ──────────────────────────────────────────────────────────────
    // One icon per card; refs stored in grid._cards[i] for fan/stack animation

    _buildIconRow(container, group, gridW, iconSize, iconOvl, padH, scale, grid) {
        const tracker = Shell.WindowTracker.get_default();
        const sz  = Math.round(iconSize * 0.92);
        const sH  = Math.round(this._gH * scale);
        const ovf = Math.round(sz * 0.28);
        const dX  = Math.round(sz * 0.72);  // horizontal spread between icons
        const dY  = Math.round(sz * 0.14);  // vertical adjustment per icon

        // Store sizing on grid so _positionFan can use it
        grid._padH    = padH;
        grid._iconSz  = sz;
        grid._iconOvf = ovf;

        grid._cards.forEach(({ win }, i) => {
            const app = tracker.get_window_app(win);
            if (!app) return;

            // Base (stacked) position — horizontal fan from corner
            let bx, by;
            if (this._pos === 'right') {
                bx = padH + gridW - sz + ovf - i * dX;
                by = sH - sz + ovf - i * dY;
            } else if (this._pos === 'bottom') {
                bx = padH - ovf + i * dX;
                by = -ovf + i * dY;
            } else {
                bx = padH - ovf + i * dX;
                by = sH - sz + ovf - i * dY;
            }

            const icon = new St.Widget({ width: sz, height: sz, reactive: false });
            icon.add_child(app.create_icon_texture(sz));
            icon.set_position(bx, by);
            container.add_child(icon);

            // Store for animation
            grid._cards[i].icon      = icon;
            grid._cards[i].iconBaseX = bx;
            grid._cards[i].iconBaseY = by;
        });
    }

    // ── Vertical layout ──────────────────────────────────────────────────────

    _redrawVertical() {
        if (!this._panel) return;
        // Cancel any pending fan/close timers before destroying children
        this._containers.forEach(c => {
            const g = c._grid;
            if (g?._fanTimer)   { GLib.source_remove(g._fanTimer);   g._fanTimer   = null; }
            if (g?._closeTimer) { GLib.source_remove(g._closeTimer); g._closeTimer = null; }
        });
        this._panel.destroy_all_children();
        this._containers = [];
        this._windowMap.clear();
        if (this._groups.length === 0) return;

        const ITEM_H  = this._gH + Math.round(this._iS * 0.5);
        const SPACING = this._vertSpacing;
        const PAD_V   = 32;
        const N       = this._groups.length;
        const geo     = this._geo;

        // Max usable height is the panel's allocated height from geometry,
        // never the full monitor height (avoids overflowing the workarea or
        // mis-centering the panel on the screen).
        const maxH     = geo.panelH;
        const contentH = N * ITEM_H + (N - 1) * SPACING + PAD_V * 2;
        const panelH   = Math.min(contentH, maxH);

        // Position: bottom panel stays fixed at its edge; lateral panels are
        // centered within the workarea strip they occupy.
        let panelY;
        if (this._pos === 'bottom') {
            panelY = geo.visY;                                           // stay at bottom
        } else {
            panelY = geo.visY + Math.round((maxH - panelH) / 2);        // center in workarea
        }

        this._panel.set_size(this._panelSize, panelH);
        this._panel.set_y(panelY);

        // Scroll: vertOffset in item units
        const maxOffset = Math.max(0, N - Math.floor((panelH - PAD_V * 2) / (ITEM_H + SPACING)));
        this._vertOffset = Math.max(0, Math.min(this._vertOffset, maxOffset));

        const startY = PAD_V - this._vertOffset * (ITEM_H + SPACING);

        this._groups.forEach((group, idx) => {
            const sW   = this._gW;
            const sH   = this._gH;
            const sI   = Math.round(this._iS * 0.8);
            const sOvl = ICON_OVL;
            const sP   = PAD_H;
            const totH = sH + sI - sOvl;
            const posX = 0;
            const posY = Math.round(startY + idx * (ITEM_H + SPACING));

            // Skip if completely outside panel
            if (posY + totH < 0 || posY > panelH) return;

            const container = new St.Widget({
                reactive: true, track_hover: true,
                width: sW + sP * 2,
                height: totH,
            });
            container.set_pivot_point(0.5, 0.5);
            container.set_position(posX, posY);
            container._baseX       = posX;
            container._baseY       = posY;
            container._baseOpacity = 255;
            container._groupRef    = group;

            const grid = this._buildGrid(group, sW, sH, 1.0);
            grid.set_position(sP, 0);
            container.add_child(grid);
            container._grid = grid;
            container._dim  = null;

            this._buildIconRow(container, group, sW, sI, sOvl, sP, 1.0, grid);

            container.connect('notify::hover', () => {
                if (container.hover) {
                    this._containers.forEach(c => {
                        const isThis = c === container;
                        c.ease({ scale_x: isThis ? 1.06 : 0.97, scale_y: isThis ? 1.06 : 0.97,
                            duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                    });
                    // Fan stack after 350ms hold
                    const g = container._grid;
                    if (g && !g._fanned && !g._fanTimer) {
                        g._fanTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                            g._fanTimer = null;
                            if (container.hover) {
                                const { shift, isBottom } = this._positionFan(g);
                                this._containers.forEach(c => {
                                    if (c === container) return;
                                    const after = isBottom
                                        ? c._baseX > container._baseX
                                        : c._baseY > container._baseY;
                                    c.ease({
                                        x: c._baseX + (after && isBottom  ? shift : 0),
                                        y: c._baseY + (after && !isBottom ? shift : 0),
                                        scale_x: 0.92, scale_y: 0.92,
                                        duration: 280, mode: Clutter.AnimationMode.EASE_OUT_BACK,
                                    });
                                });
                            }
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                } else {
                    // Cancel pending fan; start grace timer before collapsing
                    const g = container._grid;
                    if (g?._fanTimer) { GLib.source_remove(g._fanTimer); g._fanTimer = null; }
                    if (g?._fanned) {
                        if (g._closeTimer) { GLib.source_remove(g._closeTimer); g._closeTimer = null; }
                        g._closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 470, () => {
                            g._closeTimer = null;
                            if (!container.hover) {
                                this._positionStack(g);
                                this._containers.forEach(c => {
                                    c.ease({ x: c._baseX, y: c._baseY, scale_x: 1.0, scale_y: 1.0,
                                        duration: 240, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                                });
                            }
                            return GLib.SOURCE_REMOVE;
                        });
                    }

                    if (!this._containers.some(c => c.hover)) {
                        this._containers.forEach(c => {
                            c.ease({ x: c._baseX, y: c._baseY, scale_x: 1.0, scale_y: 1.0,
                                duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                        });
                    }
                }
            });

            container.connect('button-press-event', (_a, event) => {
                if (event.get_button() === 3 && group.appIds.length > 1) {
                    group.appIds.forEach(id => this._unmergeApp(id));
                    this._refresh();
                    return Clutter.EVENT_STOP;
                }
                if (event.get_button() === 1) {
                    const [px, py] = global.get_pointer();
                    this._dragStartX    = px;
                    this._dragStartY    = py;
                    this._dragCandidate = group;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            container.connect('button-release-event', (_a, event) => {
                if (this._dragging) return Clutter.EVENT_STOP;
                const btn = event.get_button();

                // Middle-click: close front window (only when stacked; cards handle it when fanned)
                if (btn === 2) {
                    if (!container._grid?._fanned) {
                        const win = group.windows[0];
                        if (win) {
                            win.delete(global.get_current_time());
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { this._refresh(); return GLib.SOURCE_REMOVE; });
                        }
                    }
                    return Clutter.EVENT_STOP;
                }

                if (btn !== 1) return Clutter.EVENT_PROPAGATE;
                this._dragCandidate = null;
                this._scrollVerticalTo(idx, () => this._activateGroup(group));
                return Clutter.EVENT_STOP;
            });

            this._containers.push(container);
            this._panel.add_child(container);
        });
    }

    _scrollVertical(delta) {
        this._vertVelocity += delta * this._scrollStep * 0.5;
        if (this._physicsId) return;
        this._physicsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            this._vertOffset  += this._vertVelocity;
            this._vertVelocity *= SCROLL_FRICTION;
            const N         = this._groups.length;
            const ITEM_H    = this._gH + Math.round(this._iS * 0.5);
            const SPACING   = this._vertSpacing;
            const PAD_V     = 32;
            const panelH    = this._panel.height;
            const maxOffset = Math.max(0, N - Math.floor((panelH - PAD_V * 2) / (ITEM_H + SPACING)));
            if (this._vertOffset < 0)         { this._vertOffset = 0;         this._vertVelocity = 0; }
            if (this._vertOffset > maxOffset) { this._vertOffset = maxOffset; this._vertVelocity = 0; }
            this._redrawVertical();
            if (Math.abs(this._vertVelocity) < SCROLL_MIN_VEL) {
                this._vertVelocity = 0;
                this._physicsId    = null;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _scrollVerticalTo(targetIdx, onComplete) {
        if (this._physicsId) { GLib.source_remove(this._physicsId); this._physicsId = null; }
        this._vertVelocity = 0;

        const N         = this._groups.length;
        const ITEM_H    = this._gH + Math.round(this._iS * 0.5);
        const SPACING   = this._vertSpacing;
        const PAD_V     = 32;
        const panelH    = this._panel ? this._panel.height : 0;
        const maxOffset = Math.max(0, N - Math.floor((panelH - PAD_V * 2) / (ITEM_H + SPACING)));

        // Only scroll if the target item is outside the visible window
        const visibleCount = Math.floor((panelH - PAD_V * 2) / (ITEM_H + SPACING));
        const target = Math.max(0, Math.min(
            targetIdx <= this._vertOffset ? targetIdx :
            targetIdx >= this._vertOffset + visibleCount ? targetIdx - visibleCount + 1 :
            this._vertOffset,
            maxOffset
        ));

        if (Math.abs(target - this._vertOffset) < 0.01) { onComplete?.(); return; }

        const start  = this._vertOffset;
        const frames = Math.max(8, Math.round(Math.abs(target - start) * 10));
        let   frame  = 0;

        this._physicsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            frame++;
            this._vertOffset = start + (target - start) * (1 - Math.pow(1 - frame / frames, 3));
            this._redrawVertical();
            if (frame >= frames) {
                this._vertOffset = target;
                this._physicsId  = null;
                this._redrawVertical();
                onComplete?.();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

        // ── Grid (stacked-papers layout) ─────────────────────────────────────────

    _buildGrid(group, gridW, gridH, scale) {
        const windows = group.windows.slice(0, 4);
        const r = Math.round(10 * scale);

        const grid = new St.Widget({
            reactive: false,
            width: gridW,
            height: gridH,
            clip_to_allocation: false,
            style: `border-radius: ${Math.round(14 * scale)}px;`,
        });
        grid._dimCells = [];
        grid._cards    = [];
        grid._fanned   = false;
        grid._fanTimer  = null;
        grid._closeTimer = null;
        grid._gridW    = gridW;
        grid._gridH    = gridH;
        grid._scale    = scale;

        windows.forEach((win, idx) => {
            const actor = win.get_compositor_private();
            const fr    = win.get_frame_rect();
            const winW  = fr.width  || gridW;
            const winH  = fr.height || gridH;
            const s     = Math.min(gridW / winW, gridH / winH);
            const cW    = Math.round(winW * s);
            const cH    = Math.round(winH * s);

            const card = new St.Widget({
                reactive: true,
                width: cW, height: cH,
                clip_to_allocation: true,
                style: `border-radius: ${r}px;`,
            });
            card.set_pivot_point(0.5, 0.5);

            if (actor)
                card.add_child(new Clutter.Clone({ source: actor, width: cW, height: cH }));
            else
                card.add_child(new St.Widget({
                    style: `background-color:#2a2a2a; border-radius:${r}px;`,
                    width: cW, height: cH,
                }));

            const dim = new St.Widget({
                reactive: false, width: cW, height: cH,
                style: `background-color: rgba(0,0,0,0.45); border-radius: ${r}px;`,
                opacity: 0,
            });
            grid._dimCells.push(dim);

            card.connect('button-release-event', (_a, ev) => {
                // Middle-click on individual card closes that specific window
                if (ev.get_button() === 2) {
                    win.delete(global.get_current_time());
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { this._refresh(); return GLib.SOURCE_REMOVE; });
                    return Clutter.EVENT_STOP;
                }
                if (ev.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
                if (idx > 0) { group.windows.splice(idx, 1); group.windows.unshift(win); }
                this._activateGroup(group, win);
                return Clutter.EVENT_STOP;
            });

            grid._cards.push({ card, dim, win, cW, cH });
        });

        // Add backmost card first so card 0 (front) ends up on top
        [...grid._cards].reverse().forEach(({ card, dim }) => {
            grid.add_child(card);
            grid.add_child(dim);
        });

        // Apply initial stack positions immediately (no animation on first build)
        this._positionStack(grid, false);

        return grid;
    }

    // ── Stack / fan animation ─────────────────────────────────────────────────

    _positionStack(grid, animate = true) {
        const scale = grid._scale;
        // Larger peek so behind cards are clearly visible
        const OFFSETS = [
            { dx: 0,                           dy: 0,                           rot:  0.0 },
            { dx: Math.round(10 * scale),      dy: Math.round( 7 * scale),      rot:  3.8 },
            { dx: Math.round(19 * scale),      dy: Math.round(13 * scale),      rot: -2.6 },
            { dx: Math.round(27 * scale),      dy: Math.round(18 * scale),      rot:  2.0 },
        ];
        grid._cards.forEach(({ card, dim, icon, iconBaseX, iconBaseY }, i) => {
            const off = OFFSETS[i] ?? OFFSETS[OFFSETS.length - 1];
            if (animate) {
                card.ease({ x: off.dx, y: off.dy, rotation_angle_z: off.rot, opacity: 255,
                    duration: 240, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            } else {
                card.set_position(off.dx, off.dy);
                card.set_rotation_angle(Clutter.RotateAxis.Z_AXIS, off.rot);
                card.opacity = 255;
            }
            dim.set_position(off.dx, off.dy);

            if (icon && iconBaseX !== undefined) {
                if (animate)
                    icon.ease({ x: iconBaseX, y: iconBaseY,
                        duration: 240, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                else
                    icon.set_position(iconBaseX, iconBaseY);
            }
        });
        grid._fanned = false;
    }

    _positionFan(grid) {
        const count = grid._cards.length;
        if (count <= 1) return { shift: 0, isBottom: false };
        const gridH    = grid._gridH;
        const gridW    = grid._gridW;
        const isBottom = this._pos === 'bottom';
        const step     = isBottom
            ? Math.round(gridW * 0.90)
            : Math.round(gridH * 0.88);

        const padH = grid._padH ?? 0;
        const sz   = grid._iconSz ?? 0;
        const ovf  = grid._iconOvf ?? 0;

        grid._cards.forEach(({ card, dim, icon, cW, cH }, i) => {
            const dx = isBottom ? i * step : 0;
            const dy = isBottom ? 0         : i * step;
            card.ease({ x: dx, y: dy, rotation_angle_z: 0, opacity: 255,
                duration: 280, mode: Clutter.AnimationMode.EASE_OUT_BACK });
            dim.set_position(dx, dy);

            if (icon && sz) {
                // Icon goes to bottom-left corner of its card (relative to container)
                // grid is at (padH, 0) in container; card at (dx, dy) in grid
                let ix, iy;
                if (isBottom) {
                    ix = padH + dx - ovf;
                    iy = dy - ovf;
                } else if (this._pos === 'right') {
                    ix = padH + dx + cW - sz + ovf;
                    iy = dy + cH - sz + ovf;
                } else {
                    // left panel
                    ix = padH + dx - ovf;
                    iy = dy + cH - sz + ovf;
                }
                icon.ease({ x: ix, y: iy, duration: 280, mode: Clutter.AnimationMode.EASE_OUT_BACK });
            }
        });
        grid._fanned = true;
        return { shift: (count - 1) * step, isBottom };
    }

    // ── Activate ──────────────────────────────────────────────────────────────

    _activateGroup(group, focusWin = null) {
        const tracker = Shell.WindowTracker.get_default();

        const focused = global.display.get_focus_window();
        if (focused) {
            const app = tracker.get_window_app(focused);
            if (app) {
                const fid = app.get_id();
                if (!this._groupStates.has(fid))
                    this._groupStates.set(fid, { savedLayout: new Map(), lastFocused: focused });
                const state = this._groupStates.get(fid);
                state.savedLayout.clear();
                global.workspace_manager.get_active_workspace().list_windows().forEach(win => {
                    const wa = tracker.get_window_app(win);
                    if (wa && wa.get_id() === fid)
                        state.savedLayout.set(win, win.get_frame_rect());
                });
            }
        }

        global.workspace_manager.get_active_workspace().list_windows().forEach(win => {
            if (!win.skip_taskbar && !group.windows.includes(win) && !win.is_attached_dialog() && !win.minimized)
                win.minimize();
        });

        group.windows.forEach(win => {
            if (win.minimized) win.unminimize();
            const app = tracker.get_window_app(win);
            if (app) {
                const state = this._groupStates.get(app.get_id());
                if (state?.savedLayout.has(win)) {
                    const rect = state.savedLayout.get(win);
                    win.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
                }
            }
        });

        let target = focusWin ?? null;
        if (!target) group.appIds.forEach(id => { if (!target) target = this._groupStates.get(id)?.lastFocused; });
        (target ?? group.windows[0])?.activate(global.get_current_time());

        this._hidePanel();
    }

    // ── Focus tracking ────────────────────────────────────────────────────────

    _trackFocus() {
        const focused = global.display.get_focus_window();
        if (!focused) return;
        const tracker = Shell.WindowTracker.get_default();
        const app     = tracker.get_window_app(focused);
        if (!app) return;
        const id = app.get_id();
        if (!this._groupStates.has(id))
            this._groupStates.set(id, { savedLayout: new Map(), lastFocused: focused });
        else
            this._groupStates.get(id).lastFocused = focused;
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    _checkPersistence() {
        if (!this._persistEnabled) {
            if (this._persistMode) { this._persistMode = false; this._hidePanel(); }
            return;
        }
        const ws  = global.workspace_manager.get_active_workspace();
        const geo = this._geo;

        // Panel's visible rect on screen
        const px1 = geo.visX;
        const py1 = geo.visY;
        const px2 = geo.visX + geo.panelW;
        const py2 = geo.visY + geo.panelH;

        // clear = no unminimized window overlaps the panel's visible area
        const clear = !ws.list_windows().some(win => {
            if (win.minimized || win.skip_taskbar || win.is_attached_dialog()) return false;
            const r = win.get_frame_rect();
            // AABB overlap test
            return r.x < px2 && r.x + r.width  > px1 &&
                   r.y < py2 && r.y + r.height > py1;
        });

        if (clear && !this._persistMode) {
            this._persistMode = true;
            if (!this._isVisible) this._showPanel();
        } else if (!clear && this._persistMode) {
            this._persistMode = false;
            this._hidePanel();
        }
    }

    // ── Monitor selection ─────────────────────────────────────────────────────
    // Prefer the monitor containing the focused window; fall back to pointer
    // monitor, then primary.

    _pickMonitor() {
        const focused = global.display.get_focus_window?.();
        if (focused) {
            const idx = global.display.get_monitor_index_for_rect?.(focused.get_frame_rect());
            if (idx != null && idx >= 0 && Main.layoutManager.monitors[idx])
                return Main.layoutManager.monitors[idx];
        }
        const ptrIdx = global.display.get_current_monitor?.();
        if (ptrIdx != null && ptrIdx >= 0 && Main.layoutManager.monitors[ptrIdx])
            return Main.layoutManager.monitors[ptrIdx];
        return Main.layoutManager.primaryMonitor;
    }

    // ── Show / Hide ───────────────────────────────────────────────────────────

    _showPanel() {
        if (this._isVisible) return;
        if (Main.overview.visible) return;

        // If the monitor changed since last build, rebuild before showing
        const newMon = this._pickMonitor();
        if (newMon !== this._monitor) {
            this._monitor = newMon;
            this._rebuild();
            return;  // _rebuild → _showPanel will be called by _checkPersistence or next hover
        }

        this._isVisible = true;
        this._cancelHide();
        this._refresh();
        const geo = this._geo;
        this._panel.ease({ x: geo.visX, y: geo.visY, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    _hidePanel() {
        if (!this._isVisible) return;
        this._isVisible = false;
        this._cancelHide();
        const geo = this._geo;
        this._panel.ease({ x: geo.hidX, y: geo.hidY, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    _startHide() {
        if (this._persistMode) return;
        this._cancelHide();
        this._hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._hideDelay, () => {
            this._hidePanel();
            this._hideTimer = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelHide() {
        if (this._hideTimer) { GLib.source_remove(this._hideTimer); this._hideTimer = null; }
    }
}
