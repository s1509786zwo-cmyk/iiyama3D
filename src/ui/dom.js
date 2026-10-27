/** Tiny DOM helpers used by every screen. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function mount(root, ...nodes) {
  clear(root);
  for (const node of nodes.flat()) if (node) root.append(node);
  return root;
}

export function button(label, { key = '', className = 'btn', onClick, disabled = false, title = '' } = {}) {
  return el(
    'button',
    {
      class: className,
      disabled,
      title,
      type: 'button',
      onClick: (e) => {
        e.stopPropagation();
        if (!disabled && onClick) onClick(e);
      },
    },
    el('span', { text: label }),
    key ? el('span', { class: 'k', text: key }) : null,
  );
}

export function mb(bytes) {
  if (!bytes) return '—';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function percent(loaded, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
}
