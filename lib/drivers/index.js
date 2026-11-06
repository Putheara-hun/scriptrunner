const LOADERS = {
  mssql: () => import('./mssql.js'),
  oracle: () => import('./oracle.js'),
  postgres: () => import('./postgres.js'),
  mysql: () => import('./mysql.js'),
};

export function isSupportedType(type) {
  return Object.hasOwn(LOADERS, type);
}

export async function openConnection(config) {
  const driver = await LOADERS[config.type]();
  return driver.open(config);
}

export function connectionErrorMessage(error) {
  return (
    error?.message ||
    error?.errors?.find((inner) => inner.message)?.message ||
    error?.code ||
    'Could not connect to the server.'
  );
}

const CONNECTION_HINTS = [
  {
    pattern: /self.signed|certificate|UNABLE_TO_VERIFY|CERT_|altname/i,
    hint: () =>
      "The server's certificate could not be verified. If you trust this server, turn off \"Verify the server's certificate\" and try again.",
  },
  {
    pattern: /ECONNREFUSED|Could not connect \(sequence\)|NJS-503/,
    hint: (config) =>
      `Nothing answered at ${config.server}:${config.port}. Check that the database server is running and the port is correct.`,
  },
  {
    pattern: /ENOTFOUND|EAI_AGAIN|getaddrinfo/,
    hint: (config) => `The server name "${config.server}" could not be found. Check the spelling and your internet connection.`,
  },
  {
    pattern: /ETIMEDOUT|ETIMEOUT|timed? ?out|in \d+ms/i,
    hint: (config) =>
      `No reply from ${config.server}:${config.port}. Check that the server is running and that its firewall allows this port.`,
  },
];

export function describeConnectionFailure(error, config) {
  const message = connectionErrorMessage(error);
  const searchable = `${message} ${error?.code ?? ''}`;
  const match = CONNECTION_HINTS.find(({ pattern }) => pattern.test(searchable));
  return match ? `${match.hint(config)}\n\nDetails: ${message}` : message;
}
