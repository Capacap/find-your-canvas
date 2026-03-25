/**
 * Svelte action that toggles `at-top` and `at-bottom` CSS classes on the
 * parent element based on scroll position. Used with the fade-container
 * pattern for scroll-fade overlays.
 */
export function trackScroll(node: HTMLElement) {
  const parent = node.parentElement!;
  function update() {
    const atTop = node.scrollTop <= 2;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 2;
    parent.classList.toggle('at-top', atTop);
    parent.classList.toggle('at-bottom', atBottom);
  }
  update();
  node.addEventListener('scroll', update, { passive: true });
  const ro = new ResizeObserver(update);
  ro.observe(node);
  return {
    destroy() {
      node.removeEventListener('scroll', update);
      ro.disconnect();
    }
  };
}
