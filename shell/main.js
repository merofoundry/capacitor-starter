/*
 * Overlay bootstrap: connects the controller to the native shell through the overlay
 * channel. Loaded last by index.html.
 */
(function (win) {
  'use strict';

  const shell = win.MeroShell;
  const post = shell.detectTransport(win);
  if (!post) {
    return;
  }
  const channel = shell.createChannel(post);
  win.MeroShellChannel = channel;

  let controller = null;
  const view = shell.createView(win.document, function (action, payload) {
    controller.act(action, payload);
  });
  controller = shell.createController({
    native: channel,
    view: view,
    log: function () {
      if (win.console) {
        win.console.warn.apply(win.console, arguments);
      }
    },
  });
  channel.onEvent(function (name, payload) {
    controller.handleEvent(name, payload);
  });
  controller.start();
})(window);
