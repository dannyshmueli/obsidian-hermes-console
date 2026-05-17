// Minimal stubs for the obsidian module used in test files.
// Only the symbols that the tested source files import at module level are included.

export class Notice {
  constructor(_msg: string, _timeout?: number) {}
}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl = {
    empty: () => {},
    createEl: () => ({}),
    createDiv: () => ({}),
  };
  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }
  display(): void {}
}

class ChainableComponent {
  inputEl = {
    addEventListener: () => {},
  };
  controlEl = {
    createSpan: () => ({}),
  };
  setName(_s: string): this { return this; }
  setDesc(_s: string): this { return this; }
  setHeading(): this { return this; }
  setButtonText(_s: string): this { return this; }
  setWarning(): this { return this; }
  setTooltip(_s: string): this { return this; }
  setIcon(_s: string): this { return this; }
  setPlaceholder(_s: string): this { return this; }
  setValue(_v: unknown): this { return this; }
  setDisabled(_v: boolean): this { return this; }
  setCta(): this { return this; }
  setLimits(_min: number, _max: number, _step: number): this { return this; }
  setDynamicTooltip(): this { return this; }
  addOption(_value: string, _label: string): this { return this; }
  onClick(_cb: () => void | Promise<void>): this { return this; }
  onChange(_cb: (value: never) => void | Promise<void>): this { return this; }
  addText(cb: (component: this) => void): this { cb(this); return this; }
  addButton(cb: (component: this) => void): this { cb(this); return this; }
  addToggle(cb: (component: this) => void): this { cb(this); return this; }
  addDropdown(cb: (component: this) => void): this { cb(this); return this; }
  addSlider(cb: (component: this) => void): this { cb(this); return this; }
  addColorPicker(cb: (component: this) => void): this { cb(this); return this; }
  addExtraButton(cb: (component: this) => void): this { cb(this); return this; }
}

export class Setting extends ChainableComponent {
  nameEl = {
    createSpan: () => ({
      style: {},
    }),
  };
  constructor(_containerEl: unknown) { super(); }
}

export class ColorComponent extends ChainableComponent {}
export class DropdownComponent extends ChainableComponent {}

export function setIcon(_el: unknown, _icon: string): void {}

export class TFile {
  path = "";
  name = "";
  basename = "";
  extension = "";
  parent = null;
  stat = { mtime: 0, ctime: 0, size: 0 };
}

export class FileSystemAdapter {
  getBasePath(): string { return ""; }
}

export class FuzzySuggestModal<T> {
  constructor(_app: unknown) {}
  open(): void {}
  close(): void {}
  setPlaceholder(_s: string): this { return this; }
  getItems(): T[] { return []; }
  getItemText(_item: T): string { return ""; }
  onChooseItem(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
}

export class App {}

export const Platform = {
  isWin: false,
  isMac: false,
  isLinux: true,
  isDesktop: true,
  isMobile: false,
};

export type EventRef = object;
