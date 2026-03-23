import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class StageArcPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this._settings = settings;
        this._window   = window;

        window.set_default_size(600, 700);

        // ── Page: Layout ─────────────────────────────────────────────────────

        const layoutPage = new Adw.PreferencesPage({
            title: 'Layout',
            icon_name: 'view-grid-symbolic',
        });
        window.add(layoutPage);

        const layoutGroup = new Adw.PreferencesGroup({ title: 'Appearance' });
        layoutPage.add(layoutGroup);

        // Position
        // Layout mode
        const modeRow = new Adw.ComboRow({
            title: 'Layout Mode',
            subtitle: 'Arc carousel or vertical stack',
            model: new Gtk.StringList({ strings: ['Arc', 'Vertical'] }),
        });
        const modeValues = ['arc', 'vertical'];
        const modeMap    = { arc: 0, vertical: 1 };
        modeRow.selected = modeMap[settings.get_string('layout-mode')] ?? 0;
        modeRow.connect('notify::selected', () =>
            settings.set_string('layout-mode', modeValues[modeRow.selected])
        );
        layoutGroup.add(modeRow);

        const posRow = new Adw.ComboRow({
            title: 'Panel Position',
            subtitle: 'Which screen edge the carousel slides in from',
            model: new Gtk.StringList({ strings: ['Left', 'Right', 'Bottom'] }),
        });
        const posValues = ['left', 'right', 'bottom'];
        const posMap    = { left: 0, right: 1, bottom: 2 };
        posRow.selected = posMap[settings.get_string('panel-position')] ?? 0;
        posRow.connect('notify::selected', () =>
            settings.set_string('panel-position', posValues[posRow.selected])
        );
        layoutGroup.add(posRow);

        // Thumbnail size
        const sizeRow = new Adw.SpinRow({
            title: 'Thumbnail Size',
            subtitle: 'Percentage of base size (100 = default)',
            adjustment: new Gtk.Adjustment({
                lower: 60, upper: 150, step_increment: 5,
                value: settings.get_int('thumbnail-size'),
            }),
        });
        sizeRow.connect('notify::value', () =>
            settings.set_int('thumbnail-size', sizeRow.value)
        );
        layoutGroup.add(sizeRow);

        // Angle
        const angleRow = new Adw.SpinRow({
            title: 'Angle Between Items',
            subtitle: 'Degrees — smaller values show more items at once',
            adjustment: new Gtk.Adjustment({
                lower: 8, upper: 30, step_increment: 1,
                value: settings.get_int('angle-step'),
            }),
        });
        angleRow.connect('notify::value', () =>
            settings.set_int('angle-step', angleRow.value)
        );
        layoutGroup.add(angleRow);

        // ── Page: Behavior ───────────────────────────────────────────────────

        const behavPage = new Adw.PreferencesPage({
            title: 'Behavior',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(behavPage);

        const behavGroup = new Adw.PreferencesGroup({ title: 'Interaction' });
        behavPage.add(behavGroup);

        // Scroll speed
        const scrollRow = new Adw.SpinRow({
            title: 'Scroll Speed',
            subtitle: '1 = slowest, 20 = fastest',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 20, step_increment: 1,
                value: settings.get_int('scroll-speed'),
            }),
        });
        scrollRow.connect('notify::value', () =>
            settings.set_int('scroll-speed', scrollRow.value)
        );
        behavGroup.add(scrollRow);

        // Hide delay
        const hideRow = new Adw.SpinRow({
            title: 'Hide Delay',
            subtitle: 'Milliseconds before the panel hides after the mouse leaves',
            adjustment: new Gtk.Adjustment({
                lower: 100, upper: 2000, step_increment: 50,
                value: settings.get_int('hide-delay'),
            }),
        });
        hideRow.connect('notify::value', () =>
            settings.set_int('hide-delay', hideRow.value)
        );
        behavGroup.add(hideRow);

        // Vertical spacing
        const vertSpacingRow = new Adw.SpinRow({
            title: 'Vertical Spacing',
            subtitle: 'Pixels between thumbnails in vertical layout mode (0–40)',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 40, step_increment: 2,
                value: settings.get_int('vert-spacing'),
            }),
        });
        vertSpacingRow.connect('notify::value', () =>
            settings.set_int('vert-spacing', vertSpacingRow.value)
        );
        behavGroup.add(vertSpacingRow);

        // Persistent mode
        const persistRow = new Adw.SwitchRow({
            title: 'Persistent Mode',
            subtitle: 'Keep panel visible when no windows overlap the edge area',
        });
        persistRow.active = settings.get_boolean('persistent-mode');
        persistRow.connect('notify::active', () =>
            settings.set_boolean('persistent-mode', persistRow.active)
        );
        behavGroup.add(persistRow);

        // ── Page: Shortcuts ──────────────────────────────────────────────────

        const keysPage = new Adw.PreferencesPage({
            title: 'Shortcuts',
            icon_name: 'input-keyboard-symbolic',
        });
        window.add(keysPage);

        const keysGroup = new Adw.PreferencesGroup({
            title: 'Keyboard Shortcuts',
            description: 'Click Set to record a shortcut, or Clear to disable it.',
        });
        keysPage.add(keysGroup);

        [
            { key: 'keybinding-toggle',   title: 'Toggle Panel',         subtitle: 'Open or close the carousel' },
            { key: 'keybinding-next',      title: 'Navigate Next',        subtitle: 'Scroll carousel forward' },
            { key: 'keybinding-prev',      title: 'Navigate Previous',    subtitle: 'Scroll carousel backward' },
            { key: 'keybinding-activate',  title: 'Activate Centered Item', subtitle: 'Switch to the app in the center' },
            { key: 'keybinding-close',     title: 'Close Focused Window', subtitle: 'Close the first window of the centered app' },
        ].forEach(({ key, title, subtitle }) =>
            keysGroup.add(this._makeKeybindingRow(key, title, subtitle))
        );
    }

    // ── Keybinding row ────────────────────────────────────────────────────────

    _makeKeybindingRow(settingKey, title, subtitle) {
        const row = new Adw.ActionRow({ title, subtitle });

        const accelLabel = new Gtk.ShortcutLabel({
            valign: Gtk.Align.CENTER,
            disabled_text: 'Disabled',
        });
        const current = this._settings.get_strv(settingKey)[0] ?? '';
        accelLabel.set_accelerator(current);

        const setBtn = new Gtk.Button({
            label: 'Set',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });

        const clearBtn = new Gtk.Button({
            label: 'Clear',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'destructive-action'],
        });

        // Live update if changed from elsewhere
        this._settings.connect(`changed::${settingKey}`, () => {
            const val = this._settings.get_strv(settingKey)[0] ?? '';
            accelLabel.set_accelerator(val);
        });

        clearBtn.connect('clicked', () => {
            this._settings.set_strv(settingKey, ['']);
            accelLabel.set_accelerator('');
        });

        setBtn.connect('clicked', () => this._captureKeybinding(settingKey, accelLabel));

        row.add_suffix(accelLabel);
        row.add_suffix(setBtn);
        row.add_suffix(clearBtn);

        return row;
    }

    _captureKeybinding(settingKey, accelLabel) {
        const dialog = new Adw.MessageDialog({
            heading: 'Set Shortcut',
            body: 'Press the key combination you want to use.\nPress Escape to cancel.',
            transient_for: this._window,
            modal: true,
        });
        dialog.add_response('cancel', 'Cancel');

        const hint = new Gtk.Label({
            label: '<span size="large">Waiting for key…</span>',
            use_markup: true,
            margin_top: 8, margin_bottom: 4,
        });
        dialog.set_extra_child(hint);

        const controller = new Gtk.EventControllerKey();
        dialog.add_controller(controller);

        controller.connect('key-pressed', (_ctrl, keyval, _keycode, state) => {
            if (keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }

            const modOnly = [
                Gdk.KEY_Control_L, Gdk.KEY_Control_R,
                Gdk.KEY_Shift_L,   Gdk.KEY_Shift_R,
                Gdk.KEY_Alt_L,     Gdk.KEY_Alt_R,
                Gdk.KEY_Super_L,   Gdk.KEY_Super_R,
                Gdk.KEY_Meta_L,    Gdk.KEY_Meta_R,
                Gdk.KEY_Hyper_L,   Gdk.KEY_Hyper_R,
            ];
            if (modOnly.includes(keyval)) return Gdk.EVENT_PROPAGATE;

            const mask  = state & Gtk.accelerator_get_default_mod_mask();
            const accel = Gtk.accelerator_name(keyval, mask);

            if (accel) {
                this._settings.set_strv(settingKey, [accel]);
                accelLabel.set_accelerator(accel);
                hint.set_label(`<span size="large"><b>${accel}</b></span>`);
            }

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                dialog.close();
                return GLib.SOURCE_REMOVE;
            });

            return Gdk.EVENT_STOP;
        });

        dialog.present();
    }
}
