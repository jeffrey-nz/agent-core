export const colors = {
  reset: (t) => `\x1b[0m${t}\x1b[0m`,
  bold: (t) => `\x1b[1m${t}\x1b[0m`,

  dim: (t) => `\x1b[2m${t}\x1b[0m`,
  muted: (t) => `\x1b[2m${t}\x1b[0m`,

  red: (t) => `\x1b[91m${t}\x1b[0m`,
  green: (t) => `\x1b[92m${t}\x1b[0m`,
  yellow: (t) => `\x1b[93m${t}\x1b[0m`,
  blue: (t) => `\x1b[94m${t}\x1b[0m`,
  magenta: (t) => `\x1b[95m${t}\x1b[0m`,
  cyan: (t) => `\x1b[96m${t}\x1b[0m`,
  white: (t) => `\x1b[97m${t}\x1b[0m`,

  bgRed: (t) => `\x1b[41m\x1b[97m${t}\x1b[0m`,
  bgGreen: (t) => `\x1b[42m\x1b[30m${t}\x1b[0m`,
  bgYellow: (t) => `\x1b[43m\x1b[30m${t}\x1b[0m`,
  bgBlue: (t) => `\x1b[44m\x1b[97m${t}\x1b[0m`,
  bgMagenta: (t) => `\x1b[45m\x1b[97m${t}\x1b[0m`,
  bgCyan: (t) => `\x1b[46m\x1b[30m${t}\x1b[0m`,
};
