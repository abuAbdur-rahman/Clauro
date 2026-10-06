/*
 * The artifact frame's runtime. Emitted as source text into a srcdoc document,
 * where there is no module system, no bundler, and no import of anything -
 * including the Tauri API, which must stay unreachable from inside the frame
 * (D6). Every line here runs inside the sandbox.
 *
 * It provides, in order:
 *   - h() / Fragment: build DOM nodes directly. No React, no runtime library,
 *     because the only thing JSX needs from us is "make me this element" (D110).
 *   - __clauroRun(moduleExports, root): render a compiled artifact's default
 *     export. Compiled code is emitted as a real <script> tag carrying the
 *     nonce, so nothing here needs eval - and the frame's CSP does not need
 *     unsafe-eval either, which is the whole point of the nonce.
 *   - the navigation guard (D102), installed before any artifact code runs.
 *   - the handshake responder: claim the transferred port, say hello, and
 *     buffer reports made before the port arrives.
 */
(function () {
  "use strict";

  var FRAME_TO_HOST = {
    hello: "artifact.hello",
    log: "artifact.log",
    error: "artifact.error",
    nav: "artifact.nav_blocked",
  };

  var port = null;
  var pending = [];

  /* ---- outbound ------------------------------------------------------- */

  function report(message) {
    if (port) {
      port.postMessage(message);
      return;
    }
    // The artifact can run before the handshake completes. Buffer, then flush;
    // dropping a log line is better than losing the first error report.
    pending.push(message);
  }

  window.__clauroReport = function (message) {
    report({ type: FRAME_TO_HOST.error, text: String(message) });
  };

  function post(type, fields) {
    var message = fields || {};
    message.type = type;
    report(message);
  }

  /* ---- h() ------------------------------------------------------------ */

  var FRAGMENT = "#fragment";

  function Fragment(children) {
    return { fragment: FRAGMENT, children: flatten([children]) };
  }

  function flatten(items, out) {
    var acc = out || [];
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (item === null || item === undefined || item === false) continue;
      if (Array.isArray(item)) {
        flatten(item, acc);
      } else {
        acc.push(item);
      }
    }
    return acc;
  }

  var SAFE_URL_SCHEMES = ["http:", "https:", "mailto:", "#"];

  function isSafeUrl(value) {
    var text = String(value).trim().toLowerCase();
    for (var i = 0; i < SAFE_URL_SCHEMES.length; i += 1) {
      if (text.indexOf(SAFE_URL_SCHEMES[i]) === 0) return true;
    }
    // Relative paths and fragments resolve against this document; anything
    // carrying a scheme we do not know (javascript:, data:, vbscript:) does not.
    return !/^[a-z][a-z0-9+.-]*:/.test(text) || text.indexOf("#") === 0;
  }

  function applyProps(node, props) {
    if (!props) return;
    Object.keys(props).forEach(function (key) {
      var value = props[key];
      if (value === null || value === undefined || value === false) return;
      if (key === "class" || key === "className") {
        node.setAttribute("class", String(value));
        return;
      }
      if (key === "style") {
        if (typeof value === "string") {
          node.setAttribute("style", value);
        } else {
          Object.keys(value).forEach(function (prop) {
            node.style.setProperty(prop, String(value[prop]));
          });
        }
        return;
      }
      if (key.indexOf("on") === 0 && key.length > 2 && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
        return;
      }
      if ((key === "href" || key === "src" || key === "action") && !isSafeUrl(value)) {
        // Dropped, not rewritten: a javascript: href that survives as text is
        // a way back in.
        return;
      }
      // `dangerouslySetInnerHTML` is deliberately not supported: an artifact
      // that wants markup writes a node, and there is no back door for one
      // string to become markup behind the guard's back.
      if (key === "dangerouslySetInnerHTML") return;
      node.setAttribute(key, value === true ? "" : String(value));
    });
  }

  function toNode(child) {
    if (child === null || child === undefined || child === false) {
      return document.createComment("empty");
    }
    if (typeof child === "string" || typeof child === "number") {
      // A string child is text. There is no path in this runtime that turns a
      // string into markup, which is the whole reason for D110.
      return document.createTextNode(String(child));
    }
    if (typeof child === "object" && child.fragment === FRAGMENT) {
      var wrapper = document.createDocumentFragment();
      child.children.forEach(function (item) {
        wrapper.appendChild(toNode(item));
      });
      return wrapper;
    }
    if (child instanceof Node) return child;
    return document.createTextNode(String(child));
  }

  function h(tag, props) {
    var node = document.createElement(tag);
    applyProps(node, props);
    for (var i = 2; i < arguments.length; i += 1) {
      flatten([arguments[i]]).forEach(function (child) {
        node.appendChild(toNode(child));
      });
    }
    return node;
  }

  // Compiled artifact code calls `h` and `Fragment` as free variables (Sucrase
  // emits them as the JSX pragma), so they have to be globals in this
  // document. They are the frame's own globals — the artifact cannot see the
  // host's, and `h` builds DOM nodes the artifact could already build itself.
  window.h = h;
  window.Fragment = Fragment;
  window.__clauroArtifact = { h: h, Fragment: Fragment };

  /* ---- rendering a compiled artifact ---------------------------------- */

  window.__clauroRun = function (moduleExports, root) {
    try {
      var tree = moduleExports && moduleExports.default;
      if (typeof tree === "function") tree = tree();
      if (tree === null || tree === undefined) return;
      var target = root || document.getElementById("root");
      if (!target) return;
      var nodes = flatten([tree]).map(toNode);
      if (typeof target.replaceChildren === "function") {
        target.replaceChildren.apply(target, nodes);
      } else {
        target.innerHTML = "";
        nodes.forEach(function (node) {
          target.appendChild(node);
        });
      }
    } catch (error) {
      window.__clauroReport("artifact threw: " + (error && error.message));
    }
  };

  /* ---- navigation guard (D102) ---------------------------------------- */

  var ESCAPING_TARGETS = ["_top", "_parent", "_blank"];

  function blockedNavigationNote(anchor) {
    var target = anchor.getAttribute("target");
    if (target && ESCAPING_TARGETS.indexOf(target.toLowerCase()) >= 0) {
      return "blocked: target " + target;
    }
    var href = (anchor.getAttribute("href") || "").trim();
    if (href === "" || href.charAt(0) === "#") return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.indexOf("//") === 0) {
      return "blocked: " + href.slice(0, 80) + " leaves the artifact frame (D102)";
    }
    return null;
  }

  document.addEventListener(
    "click",
    function (event) {
      var anchor = event.target && event.target.closest && event.target.closest("a");
      if (!anchor) return;
      var note = blockedNavigationNote(anchor);
      if (!note) return;
      event.preventDefault();
      post(FRAME_TO_HOST.nav, { text: note });
    },
    // Capture: an artifact's own listener must never get to navigate first.
    { capture: true },
  );

  document.addEventListener(
    "submit",
    function (event) {
      var action = (event.target && event.target.getAttribute("action")) || "";
      if (action.trim() === "") return;
      event.preventDefault();
      post(FRAME_TO_HOST.log, {
        level: "warn",
        text: "blocked: form submission to " + action.slice(0, 80) + " (D102)",
      });
    },
    { capture: true },
  );

  /* ---- handshake (D6) -------------------------------------------------- */

  window.addEventListener("message", function (event) {
    var data = event.data;
    // The host's window, and only the host's window. Anything else speaking
    // this frame gets no port.
    if (event.source !== window.parent) return;
    if (!data || data.type !== "artifact.boot") return;
    if (!event.ports || event.ports.length !== 1) return;
    port = event.ports[0];
    port.onmessage = function (msg) {
      var inbound = msg.data;
      // The host sends exactly one other thing, and the frame acts on nothing.
      if (inbound && inbound.type === "artifact.dispose") {
        post(FRAME_TO_HOST.log, { level: "info", text: "artifact disposed" });
      }
    };
    port.start();
    pending.forEach(function (message) {
      port.postMessage(message);
    });
    pending = [];
    post(FRAME_TO_HOST.hello, {});
  });

  window.onerror = function (message) {
    post(FRAME_TO_HOST.error, { text: String(message) });
  };
})();