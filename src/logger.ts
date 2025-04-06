export interface Logger {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const log = (...args: unknown[]) => console.log("[mpc-server-proxy]", ...args);
const logStderr = (...args: unknown[]) =>
  console.error("[mpc-server-proxy]", ...args);

const noneLogger: Logger = {
  info: () => {},
  error: () => {},
};

export const getLogger = ({
  logLevel,
  outputTransport,
}: {
  logLevel: string;
  outputTransport: string;
}): Logger => {
  if (logLevel === "none") {
    return noneLogger;
  }

  if (outputTransport === "stdio") {
    return { info: logStderr, error: logStderr };
  }

  return { info: log, error: logStderr };
};
