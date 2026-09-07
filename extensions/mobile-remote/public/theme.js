(() => {
  const key = "synara-mobile-theme-v1";
  const colors = [
    "--background",
    "--foreground",
    "--card",
    "--muted-foreground",
    "--border",
    "--input",
    "--primary",
    "--primary-foreground",
    "--secondary",
    "--color-border-focus",
  ];
  const root = document.documentElement;
  if (location.pathname === "/mobile" || location.pathname.startsWith("/mobile/")) {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      if (!saved || saved.version !== 1) return;
      for (const name of colors)
        if (typeof saved[name] === "string" && CSS.supports("color", saved[name]))
          root.style.setProperty(name, saved[name]);
      if (["dark", "light"].includes(saved.scheme)) root.style.colorScheme = saved.scheme;
      const background = getComputedStyle(root).getPropertyValue("--background").trim();
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", background);
    } catch {}
    return;
  }
  function capture() {
    const style = getComputedStyle(root);
    const saved = { version: 1, scheme: style.colorScheme };
    for (const name of colors) saved[name] = style.getPropertyValue(name).trim();
    if (!saved["--background"] || !saved["--foreground"]) return;
    try {
      localStorage.setItem(key, JSON.stringify(saved));
    } catch {}
  }
  const observer = new MutationObserver(capture);
  observer.observe(root, { attributes: true, attributeFilter: ["class", "style"] });
  requestAnimationFrame(capture);
})();
