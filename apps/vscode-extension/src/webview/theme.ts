// VSCode sets one of these classes on <body>: vscode-dark | vscode-light | vscode-high-contrast.
// Our reused tokens.css keys off [data-theme="dark"|"light"], so mirror the body class onto
// the documentElement. Minimum-viable theming (a fuller token→--vscode-* mapping is deferred).
export function initWebviewTheme(): void {
  const apply = (): void => {
    const cls = document.body.className;
    const dark = cls.includes("vscode-dark") || cls.includes("vscode-high-contrast");
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  };
  apply();
  new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ["class"] });
}
