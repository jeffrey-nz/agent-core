import { z } from "zod";

export const httpTools = {
  http_request: {
    description: "Make an HTTP request to a URL.",
    parameters: z.object({
      url: z.string().describe("The full URL to request."),
      method: z.string().optional(),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
      follow_redirects: z.boolean().optional(),
    }),
  },
};
