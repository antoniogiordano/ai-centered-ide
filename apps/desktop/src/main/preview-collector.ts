/**
 * The function the element picker runs on a picked DOM node, shipped as source
 * because CDP evaluates it inside the preview page.
 *
 * It runs in the page's main world on purpose: React attaches its fiber as an
 * expando on the DOM node, and expandos are per-world, so an isolated world —
 * safer in every other respect — cannot see the component chain at all. The
 * consequence is that everything coming back is untrusted input: read-only,
 * capped in size here, and treated as page content by whatever reads it.
 *
 * Kept free of imports and of any reference to the IDE so it can be sent as a
 * plain string, and written in ES5-ish style because the target is whatever
 * Chromium the preview runs, not our build.
 */
export const ELEMENT_COLLECTOR = `function () {
  var el = this;
  var MAX_TEXT = 120;
  var TEST_ATTRS = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"];

  function cap(value, max) {
    if (typeof value !== "string") return null;
    var trimmed = value.replace(/\\s+/g, " ").trim();
    if (!trimmed) return null;
    return trimmed.length > max ? trimmed.slice(0, max) + "…" : trimmed;
  }

  function esc(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  }

  function attr(node, name) {
    return node && node.getAttribute ? node.getAttribute(name) : null;
  }

  function nthOfType(node) {
    var index = 1;
    var sibling = node;
    while ((sibling = sibling.previousElementSibling)) {
      if (sibling.tagName === node.tagName) index += 1;
    }
    return index;
  }

  var tagName = (el.tagName || "unknown").toLowerCase();

  var testAttr = null;
  var testId = null;
  for (var i = 0; i < TEST_ATTRS.length; i += 1) {
    var found = attr(el, TEST_ATTRS[i]);
    if (found) {
      testAttr = TEST_ATTRS[i];
      testId = found;
      break;
    }
  }

  var text = cap(el.innerText || el.textContent, MAX_TEXT);
  var accessibleName =
    cap(attr(el, "aria-label"), MAX_TEXT) ||
    cap(attr(el, "title"), MAX_TEXT) ||
    cap(attr(el, "placeholder"), MAX_TEXT) ||
    cap(attr(el, "alt"), MAX_TEXT) ||
    text;

  // Emotion/styled-components hashes change on every build: useless as anchors.
  var classNames = [];
  if (el.classList) {
    for (var c = 0; c < el.classList.length && classNames.length < 12; c += 1) {
      var name = el.classList[c];
      if (!/^(css-|sc-|jsx-|emotion-|_)/.test(name)) classNames.push(name);
    }
  }

  var selectors = [];
  if (testId && testAttr) selectors.push("[" + testAttr + '="' + testId + '"]');
  if (el.id) selectors.push("#" + esc(el.id));
  var role = attr(el, "role");
  if (role && accessibleName) {
    selectors.push('role=' + role + ' name="' + accessibleName + '"');
  }
  if (classNames.length) {
    selectors.push(tagName + "." + classNames.map(esc).join("."));
  }

  // Structural fallback: short enough to read, specific enough to find once.
  var path = [];
  var node = el;
  var depth = 0;
  while (node && node.nodeType === 1 && depth < 5) {
    var step = node.tagName.toLowerCase();
    var idAttr = node.id;
    if (idAttr) {
      path.unshift("#" + esc(idAttr));
      break;
    }
    path.unshift(step + ":nth-of-type(" + nthOfType(node) + ")");
    node = node.parentElement;
    depth += 1;
  }
  if (path.length) selectors.push(path.join(" > "));

  var componentChain = [];
  var fiberKey = null;
  var keys = Object.keys(el);
  for (var k = 0; k < keys.length; k += 1) {
    if (
      keys[k].indexOf("__reactFiber$") === 0 ||
      keys[k].indexOf("__reactInternalInstance$") === 0
    ) {
      fiberKey = keys[k];
      break;
    }
  }
  var fiber = fiberKey ? el[fiberKey] : null;
  var guard = 0;
  while (fiber && componentChain.length < 8 && guard < 200) {
    guard += 1;
    var type = fiber.type;
    var displayName = null;
    if (typeof type === "function") {
      displayName = type.displayName || type.name || null;
    } else if (type && typeof type === "object") {
      displayName =
        type.displayName ||
        (type.render && (type.render.displayName || type.render.name)) ||
        null;
    }
    if (
      displayName &&
      displayName !== "Unknown" &&
      componentChain.indexOf(displayName) === -1
    ) {
      componentChain.push(displayName);
    }
    fiber = fiber.return;
  }

  var box = el.getBoundingClientRect();
  return {
    tagName: tagName,
    selectors: selectors.slice(0, 8),
    testId: testId,
    role: role || null,
    accessibleName: accessibleName,
    text: text,
    classNames: classNames,
    componentChain: componentChain,
    rect: {
      x: box.left,
      y: box.top,
      width: box.width,
      height: box.height,
    },
  };
}`;
