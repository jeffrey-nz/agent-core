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
};
