import Meta from 'gi://Meta';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

export default class StageMode extends Extension {
    
    enable() {
        this.monitor = Main.layoutManager.primaryMonitor;
        this.panelWidth = 260;
        this.isVisible = false;
        this.hideTimeout = null;
        this.hideDelay = 350;

        this.windowMap = new Map();
        this.groupStates = new Map(); // ← NOVO
        this._refreshTimeout = null;

        this.panel = new St.Widget({
            reactive: true,
            track_hover: true,
            style: `background-color: transparent;`
        });

        this.panel.set_size(this.panelWidth, this.monitor.height);
        this.panel.set_position(
            this.monitor.x - this.panelWidth,
            this.monitor.y
        );

        Main.layoutManager.addChrome(this.panel, {
            trackFullscreen: true
        });

        this.scrollView = new St.ScrollView({
            overlay_scrollbars: false,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER,
            clip_to_allocation: true,
        });

        this.scrollView.set_size(this.panelWidth, this.monitor.height);
        this.panel.add_child(this.scrollView);

        this.scrollView.connect('scroll-event', (actor, event) => {
            let adjustment = this.scrollView.vadjustment;
            let [dx, dy] = event.get_scroll_delta();

            adjustment.value = Math.max(
                0,
                Math.min(
                    adjustment.upper - adjustment.page_size,
                    adjustment.value + dy * 55
                )
            );

            return Clutter.EVENT_STOP;
        });

        this.contentBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            style: 'padding: 60px 0px; spacing: 16px;'
        });

        this.scrollView.set_child(this.contentBox);

        this.edgeZone = new St.Widget({
            reactive: true,
            style: 'background-color: rgba(255,255,255,0.01);'
        });

        this.edgeZone.set_size(4, 300);
        this.edgeZone.set_position(
            this.monitor.x,
            this.monitor.y + (this.monitor.height / 2) - 150
        );

        Main.layoutManager.addChrome(this.edgeZone);

        this.edgeZone.connect('enter-event', () => {
            if (!this.isVisible)
                this.showPanel();
        });

        this.panel.connect('leave-event', () => {
            if (this.isVisible)
                this.startHideTimer();
        });

        this.panel.connect('enter-event', () => {
            this.cancelHideTimer();
        });

        this._focusSignal = global.display.connect(
            'notify::focus-window',
            () => this._trackFocusedWindow()
        );

        this.refreshWindows();
    }

    refreshWindows() {
        if (this._refreshTimeout)
            GLib.source_remove(this._refreshTimeout);

        this._refreshTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            50,
            () => {
                this._doRefreshWindows();
                this._refreshTimeout = null;
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _trackFocusedWindow() {
        let focused = global.display.get_focus_window();
        if (!focused) return;

        let tracker = Shell.WindowTracker.get_default();
        let app = tracker.get_window_app(focused);
        if (!app) return;

        let id = app.get_id();

        if (!this.groupStates.has(id)) {
            this.groupStates.set(id, {
                savedLayout: new Map(),
                lastFocused: focused
            });
        } else {
            this.groupStates.get(id).lastFocused = focused;
        }

        this.updateFocusIndicator();
    }

    _saveCurrentGroupLayout() {
        let focused = global.display.get_focus_window();
        if (!focused) return;

        let tracker = Shell.WindowTracker.get_default();
        let app = tracker.get_window_app(focused);
        if (!app) return;

        let id = app.get_id();

        if (!this.groupStates.has(id))
            return;

        let state = this.groupStates.get(id);
        state.savedLayout.clear();

        let workspace = global.workspace_manager.get_active_workspace();
        let windows = workspace.list_windows();

        windows.forEach(win => {
            let winApp = tracker.get_window_app(win);
            if (winApp && winApp.get_id() === id) {
                let rect = win.get_frame_rect();
                state.savedLayout.set(win, rect);
            }
        });
    }

    _restoreGroupLayout(group) {
        let id = group.app.get_id();
        if (!this.groupStates.has(id))
            return;

        let state = this.groupStates.get(id);

        group.windows.forEach(win => {

            if (win.minimized)
                win.unminimize();

            if (state.savedLayout.has(win)) {
                let rect = state.savedLayout.get(win);
                win.move_resize_frame(
                    true,
                    rect.x,
                    rect.y,
                    rect.width,
                    rect.height
                );
            }
        });

        if (state.lastFocused)
            state.lastFocused.activate(global.get_current_time());
    }

    _doRefreshWindows() {

        this.contentBox.destroy_all_children();
        this.windowMap.clear();

        let workspace = global.workspace_manager.get_active_workspace();
        let windows = workspace.list_windows();
        let tracker = Shell.WindowTracker.get_default();
        let grouped = {};

        windows.forEach(win => {

            if (!win.skip_taskbar &&
                win.get_compositor_private() &&
                !win.is_attached_dialog()) {

                let app = tracker.get_window_app(win);
                if (!app) return;

                let id = app.get_id();

                if (!grouped[id])
                    grouped[id] = { app: app, windows: [] };

                grouped[id].windows.push(win);
            }
        });

        Object.values(grouped).forEach(group => {

            let win = group.windows[0];
            let windowActor = win.get_compositor_private();

            let clone = new Clutter.Clone({
                source: windowActor,
                width: 200,
                height: 120
            });

            let thumbnailWrapper = new St.Widget({
                reactive: true,
                style: `border-radius: 16px;`
            });

            thumbnailWrapper.add_child(clone);

            let icon = group.app.create_icon_texture(30);

            let container = new St.BoxLayout({
                vertical: true,
                reactive: true,
                x_align: Clutter.ActorAlign.CENTER,
                style: `padding: 16px;`
            });

            container.add_child(thumbnailWrapper);

            let iconBox = new St.BoxLayout({
                x_align: Clutter.ActorAlign.CENTER,
                style: 'margin-top: 12px;'
            });

            iconBox.add_child(icon);
            container.add_child(iconBox);

            container.connect('button-release-event', () => {

                // SALVA layout atual antes de trocar
                this._saveCurrentGroupLayout();

                let workspace = global.workspace_manager.get_active_workspace();
                let allWindows = workspace.list_windows();

                // Minimiza janelas de outros grupos
                allWindows.forEach(other => {
                    if (!other.skip_taskbar &&
                        !group.windows.includes(other) &&
                        !other.is_attached_dialog() &&
                        !other.minimized) {
                        other.minimize();
                    }
                });

                this._restoreGroupLayout(group);

                this.hidePanel();
                return Clutter.EVENT_STOP;
            });

            this.contentBox.add_child(container);

            group.windows.forEach(w => {
                this.windowMap.set(w, thumbnailWrapper);
            });
        });

        this.updateFocusIndicator();
    }

    updateFocusIndicator() {
        let focused = global.display.get_focus_window();

        this.windowMap.forEach((thumbWrapper, win) => {
            if (win === focused && win) {
                thumbWrapper.set_style(`
                    border-radius: 16px;
                    box-shadow: 0 0 0 3px #FFD700;
                `);
            } else {
                thumbWrapper.set_style(`
                    border-radius: 16px;
                    box-shadow: none;
                `);
            }
        });
    }

    showPanel() {
        if (this.isVisible) return;

        this.isVisible = true;
        this.cancelHideTimer();
        this.refreshWindows();

        this.panel.ease({
            x: this.monitor.x,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
    }

    hidePanel() {
        if (!this.isVisible) return;

        this.isVisible = false;
        this.cancelHideTimer();

        this.panel.ease({
            x: this.monitor.x - this.panelWidth,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
    }

    startHideTimer() {
        this.cancelHideTimer();

        this.hideTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            this.hideDelay,
            () => {
                this.hidePanel();
                this.hideTimeout = null;
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    cancelHideTimer() {
        if (this.hideTimeout) {
            GLib.source_remove(this.hideTimeout);
            this.hideTimeout = null;
        }
    }

    disable() {

        this.cancelHideTimer();

        if (this._refreshTimeout)
            GLib.source_remove(this._refreshTimeout);

        if (this._focusSignal)
            global.display.disconnect(this._focusSignal);

        if (this.edgeZone)
            this.edgeZone.destroy();

        if (this.panel)
            this.panel.destroy();
    }
}
