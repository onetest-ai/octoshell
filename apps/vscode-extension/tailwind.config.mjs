/** @type {import('tailwindcss').Config} */
// Self-contained theme (previously inherited from apps/desktop, now retired). All colors map
// to CSS variables set by the VS Code theme bridge — never hardcode colors in components.
export default {
  content: [
    "./src/webview/index.html",
    "./src/webview/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // App surfaces
        app: "var(--ds-bg-app)",
        sidebar: "var(--ds-bg-sidebar)",
        panel: "var(--ds-bg-panel)",
        statusbar: "var(--ds-bg-statusbar)",
        titlebar: "var(--ds-bg-titlebar)",
        canvas: "var(--ds-bg-canvas)",
        codeblock: "var(--ds-bg-codeblock)",
        tooltip: "var(--ds-bg-tooltip)",
        // List states
        "list-hover": "var(--ds-bg-list-hover)",
        "list-active": "var(--ds-bg-list-active)",
        "list-active-inactive": "var(--ds-bg-list-active-inactive)",
        // Inputs
        input: "var(--ds-bg-input)",
        "input-disabled": "var(--ds-bg-input-disabled)",
        "input-border": "var(--ds-border-input)",
        // Buttons
        "btn-primary": "var(--ds-bg-button)",
        "btn-primary-hover": "var(--ds-bg-button-hover)",
        "btn-secondary": "var(--ds-bg-button-secondary)",
        "btn-secondary-hover": "var(--ds-bg-button-secondary-hover)",
        // Badge
        badge: "var(--ds-bg-badge)",
        // Foreground
        fg: "var(--ds-fg-app)",
        "fg-muted": "var(--ds-fg-muted)",
        "fg-disabled": "var(--ds-fg-disabled)",
        "fg-link": "var(--ds-fg-link)",
        "fg-button": "var(--ds-fg-button)",
        "fg-badge": "var(--ds-fg-badge)",
        "fg-input": "var(--ds-fg-input)",
        "fg-list-active": "var(--ds-fg-list-active)",
        "fg-tooltip": "var(--ds-fg-tooltip)",
        // Border
        border: "var(--ds-border)",
        "border-panel": "var(--ds-border-panel)",
        focus: "var(--ds-focus)",
        // Status
        "status-info": "var(--ds-status-info)",
        "status-warning": "var(--ds-status-warning)",
        "status-error": "var(--ds-status-error)",
        "status-success": "var(--ds-status-success)",
        // Mission status
        "mission-draft": "var(--ds-mission-draft)",
        "mission-executing": "var(--ds-mission-executing)",
        "mission-awaiting": "var(--ds-mission-awaiting)",
        "mission-done": "var(--ds-mission-done)",
        "mission-failed": "var(--ds-mission-failed)",
        "mission-cancelled": "var(--ds-mission-cancelled)",
        // Git decorations
        "git-added": "var(--ds-git-added)",
        "git-modified": "var(--ds-git-modified)",
        "git-deleted": "var(--ds-git-deleted)",
      },
      fontFamily: {
        ui: "var(--ds-font-family-ui)",
        mono: "var(--ds-font-family-mono)",
      },
      fontSize: {
        base: "var(--ds-font-size-base)",
        sm: "var(--ds-font-size-sm)",
        xs: "var(--ds-font-size-xs)",
        code: "var(--ds-font-size-code)",
      },
      spacing: {
        0.5: "var(--ds-space-1)",
        1: "var(--ds-space-2)",
        1.5: "var(--ds-space-3)",
        2: "var(--ds-space-4)",
        2.5: "var(--ds-space-5)",
        3: "var(--ds-space-6)",
        4: "var(--ds-space-8)",
        5: "var(--ds-space-10)",
        6: "var(--ds-space-12)",
        row: "var(--ds-row-h)",
        "row-compact": "var(--ds-row-h-compact)",
        icon: "var(--ds-icon)",
        "icon-sm": "var(--ds-icon-sm)",
        "icon-lg": "var(--ds-icon-lg)",
      },
      borderRadius: {
        sm: "var(--ds-radius-sm)",
        DEFAULT: "var(--ds-radius)",
        lg: "var(--ds-radius-lg)",
      },
      transitionDuration: {
        fast: "var(--ds-dur-fast)",
        DEFAULT: "var(--ds-dur-base)",
        slow: "var(--ds-dur-slow)",
      },
      transitionTimingFunction: {
        standard: "var(--ds-ease-standard)",
        emphasized: "var(--ds-ease-emphasized)",
      },
      zIndex: {
        dropdown: "var(--ds-z-dropdown)",
        tooltip: "var(--ds-z-tooltip)",
        "context-menu": "var(--ds-z-context-menu)",
        modal: "var(--ds-z-modal)",
        toast: "var(--ds-z-toast)",
      },
    },
  },
  plugins: [],
};
