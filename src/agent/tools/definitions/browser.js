import { z } from "zod";

/**
 * Browser/dev-server tool schemas.
 *
 * These tools let the agent interact with running web apps without desktop
 * automation by delegating to the browser-ai-bridge sidecar service.
 *
 * Tools:
 *   screenshot_url   — capture a browser screenshot of any URL
 *   inspect_page     — DOM + React mount status + console errors for a URL
 *   start_dev_server — spin up an npm dev server, get back a URL to test
 *   stop_dev_server  — shut down a previously started dev server
 */

export const browserTools = {
  screenshot_url: {
    description:
      "Capture a browser screenshot of a URL and display it so you can see the visual result. " +
      "Use this after starting a dev server to verify the app looks correct. " +
      "Returns the screenshot image so you can inspect the UI visually.",
    parameters: z.object({
      url: z.string().describe("Fully-qualified URL to screenshot (e.g. http://localhost:5173)."),
      width: z.number().int().optional().describe("Viewport width in pixels. Defaults to 1280."),
      height: z.number().int().optional().describe("Viewport height in pixels. Defaults to 900."),
      full_page: z.boolean().optional().describe("Capture the full scrollable page. Defaults to false."),
      delay_ms: z.number().int().optional().describe("Milliseconds to wait after page load before capturing. Useful for animations. Defaults to 0."),
      dark_mode: z.boolean().optional().describe("Emulate prefers-color-scheme: dark. Defaults to false."),
    }),
  },

  inspect_page: {
    description:
      "Inspect a running web page for DOM state, React mount status, and console errors. " +
      "Returns whether React mounted successfully, any error overlays, visible console errors, " +
      "and a snippet of the rendered DOM. Use this to diagnose blank pages, crashes, or import errors " +
      "without needing to see the screenshot.",
    parameters: z.object({
      url: z.string().describe("Fully-qualified URL to inspect (e.g. http://localhost:5173)."),
    }),
  },

  start_dev_server: {
    description:
      "Start an npm dev server for a web project via the bridge and return its URL. " +
      "After calling this, use screenshot_url(url) or inspect_page(url) to verify the app. " +
      "Always call stop_dev_server(pid) when finished to avoid leaving orphan processes. " +
      "Works for React/Vite/Next.js/Nuxt projects with a 'dev' npm script.",
    parameters: z.object({
      project_dir: z.string().optional().describe("Absolute path to the project root. Defaults to the current workspace root."),
      command: z.string().optional().describe("npm script to run. Defaults to 'npm run dev'."),
      port: z.number().int().optional().describe("Preferred port. The bridge picks a free port near this value. Defaults to 5173."),
    }),
  },

  stop_dev_server: {
    description:
      "Stop a dev server that was previously started with start_dev_server. " +
      "Always call this when you are done testing to avoid leaving orphan processes.",
    parameters: z.object({
      pid: z.union([z.string(), z.number()]).describe("Process ID returned by start_dev_server."),
    }),
  },

  click_element: {
    description:
      "Navigate to a URL, wait for a CSS selector to become visible, click it, then return the " +
      "resulting DOM state so you can verify the effect. " +
      "Use this to: click nav tabs and verify the content changes, submit forms and check " +
      "success/error states, or toggle UI elements like modals and dropdowns. " +
      "Returns resultHtml (DOM after click), errorOverlay, and consoleErrors.",
    parameters: z.object({
      url: z.string().describe("Fully-qualified URL to load (e.g. http://localhost:5173)."),
      selector: z.string().describe("CSS selector of the element to click (e.g. 'button.submit', '#tab-about', '[data-testid=\"ok\"]')."),
      wait_after_ms: z
        .number()
        .int()
        .optional()
        .describe("Milliseconds to wait after clicking before capturing DOM. Defaults to 800. Use higher values for slow animations."),
      session_id: z.string().optional().describe("Optional session ID for bridge log correlation."),
    }),
  },

  wait_for_selector: {
    description:
      "Navigate to a URL and wait until a CSS selector appears in the DOM (or disappears, if state='hidden'). " +
      "Returns whether the element was found within the timeout and its visible text. " +
      "Use this to: wait for a loading spinner to disappear, confirm a success toast appears, " +
      "or verify lazy-loaded content eventually renders. " +
      "Pair with click_element: click something, then wait_for_selector to confirm the result.",
    parameters: z.object({
      url: z.string().describe("Fully-qualified URL to load (e.g. http://localhost:5173)."),
      selector: z.string().describe("CSS selector to wait for (e.g. '.success-toast', '#result', '[aria-label=\"loaded\"]')."),
      timeout_ms: z
        .number()
        .int()
        .optional()
        .describe("Maximum milliseconds to wait. Defaults to 10 000. Max 30 000."),
      state: z
        .enum(["visible", "attached", "hidden", "detached"])
        .optional()
        .describe("DOM state to wait for. 'visible' (default): element is in DOM and visible. 'hidden'/'detached': element has gone away."),
      session_id: z.string().optional().describe("Optional session ID for bridge log correlation."),
    }),
  },

  evaluate_js: {
    description:
      "Run JavaScript in a live browser page and return the result. " +
      "Navigate to `url`, execute `script` in the page context, and return whatever the script returns. " +
      "Use `return` at the top level — the script is wrapped in a function automatically. " +
      "Examples: check element counts, read DOM state, simulate a click, read computed styles. " +
      "Returns { result, error, logs } where logs captures console output during execution.",
    parameters: z.object({
      url: z.string().describe("Fully-qualified URL to load before running the script (e.g. http://localhost:5173)."),
      script: z
        .string()
        .describe(
          "JavaScript to execute in the page. Use `return` to return a value. " +
          "Example: \"return document.querySelectorAll('button').length\" " +
          "Example: \"const el = document.getElementById('root'); return el ? el.childElementCount : -1\"",
        ),
      session_id: z.string().optional().describe("Optional session ID for correlation in bridge logs."),
    }),
  },

  list_dev_servers: {
    description:
      "List all dev servers currently running in the bridge. " +
      "Returns pid, port, url, and project directory for each running server. " +
      "Use this when you need to find the PID of a previously started dev server " +
      "or verify whether a dev server is already running before starting a new one.",
    parameters: z.object({}),
  },

  get_dev_server_logs: {
    description:
      "Get recent stdout and stderr output from a running dev server. " +
      "Use this when the dev server crashes, a page shows errors, or you want to see " +
      "build output such as TypeScript errors, Vite HMR messages, or startup warnings. " +
      "Returns the last N lines of combined stdout+stderr from the process.",
    parameters: z.object({
      pid: z.union([z.string(), z.number()]).describe("Process ID of the dev server (from start_dev_server or list_dev_servers)."),
      lines: z.number().int().optional().describe("Approximate number of log lines to return. Defaults to 100."),
    }),
  },
};
