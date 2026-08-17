// Mock `window.AGENTX_SERVICE` for local development outside a real WxCC
// Desktop session. In production, the WxCC Desktop host injects this
// global before @wxcc-desktop/sdk evaluates; without it the SDK throws
// `ReferenceError: AGENTX_SERVICE is not defined` at import time.
//
// Only installs if the real global isn't already present, so this is a
// no-op inside an actual WxCC Desktop deployment (see index.html, which
// only loads this file when window.AGENTX_SERVICE is missing).
(function () {
  if (window.AGENTX_SERVICE) return;

  var listeners = {}; // "module.event" -> callback[]

  function on(mod, event, cb) {
    var key = mod + "." + event;
    (listeners[key] = listeners[key] || []).push(cb);
    console.log("[MOCK] " + key + " listener registered");
  }

  function ok(data) {
    return Promise.resolve({ success: true, data: data });
  }

  window.AGENTX_SERVICE = {
    config: {
      init: function (cfg) {
        console.log("[MOCK] config.init", cfg);
        return Promise.resolve();
      },
      registerCrmConnector: function (cfg) {
        console.log("[MOCK] config.registerCrmConnector", cfg);
      },
    },
    logger: {
      createLogger: function (prefix) {
        var tag = "[" + prefix + "]";
        return {
          info: function () { console.log.apply(console, [tag].concat(Array.prototype.slice.call(arguments))); },
          debug: function () { console.debug.apply(console, [tag].concat(Array.prototype.slice.call(arguments))); },
          warn: function () { console.warn.apply(console, [tag].concat(Array.prototype.slice.call(arguments))); },
          error: function () { console.error.apply(console, [tag].concat(Array.prototype.slice.call(arguments))); },
        };
      },
    },
    agentContact: {
      addEventListener: function (event, cb) { on("agentContact", event, cb); },
      accept: function (data) { console.log("[MOCK] agentContact.accept", data); return ok(data); },
      end: function (data) { console.log("[MOCK] agentContact.end", data); return ok(data); },
      hold: function (data) { console.log("[MOCK] agentContact.hold", data); return ok(data); },
      unHold: function (data) { console.log("[MOCK] agentContact.unHold", data); return ok(data); },
      wrapup: function (data) { console.log("[MOCK] agentContact.wrapup", data); return ok(data); },
    },
    screenpop: {
      addEventListener: function (event, cb) { on("screenpop", event, cb); },
    },
    dialer: {
      startOutdial: function (data) { console.log("[MOCK] dialer.startOutdial", data); return ok(data); },
    },
    agentStateInfo: {
      stateChange: function (data) { console.log("[MOCK] agentStateInfo.stateChange", data); return ok(data); },
    },
  };

  // Dev helper: fire a mocked WxCC event from the browser console to
  // exercise the app end-to-end without a real Desktop session, e.g.
  //
  //   __mockWxCC.fire("agentContact", "eAgentOfferContact", {
  //     interactionId: "abc123", ani: "+15551234567", dnis: "100", queueName: "Support"
  //   })
  //   __mockWxCC.fire("agentContact", "eAgentContact", { interactionId: "abc123" })
  window.__mockWxCC = {
    fire: function (mod, event, detail) {
      var key = mod + "." + event;
      var cbs = listeners[key] || [];
      if (cbs.length === 0) {
        console.warn("[MOCK] no listener registered for " + key);
        return;
      }
      cbs.forEach(function (cb) { cb(detail); });
    },
  };

  console.log(
    "[MOCK] AGENTX_SERVICE installed for standalone dev — use window.__mockWxCC.fire(module, event, detail) to simulate WxCC events"
  );
})();
