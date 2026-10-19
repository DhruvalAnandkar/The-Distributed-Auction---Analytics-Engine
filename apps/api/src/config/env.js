import { z } from 'zod';

/**
 * @typedef {Object} AppConfig
 * @property {number} PORT - Application HTTP server port.
 * @property {string} DB_HOST - Database host address.
 * @property {number} DB_PORT - Database port.
 * @property {string} DB_USER - Database username.
 * @property {string} DB_PASSWORD - Database password.
 * @property {string} DB_NAME - Database name.
 * @property {string} JWT_SECRET - Secret key for JWT signing and verification.
 * @property {string} [CORS_ORIGINS] - Optional comma-separated CORS allowed origins.
 * @property {string} [ADMIN_TOKEN] - Optional secret token for admin endpoints.
 * @property {string} NODE_ENV - Application runtime environment.
 */

/**
 * Builds the environment validation schema based on whether the environment is 'test'.
 *
 * @param {boolean} isTest - Indicates if NODE_ENV === 'test'.
 * @returns {import('zod').ZodObject<any>}
 */
function createEnvSchema(isTest) {
  return z.object({
    PORT: z.coerce
      .number({
        invalid_type_error: 'PORT must be a valid port number',
      })
      .int('PORT must be an integer')
      .min(1, 'PORT must be between 1 and 65535')
      .max(65535, 'PORT must be between 1 and 65535')
      .default(5001),

    DB_HOST: z
      .string({
        required_error: 'DB_HOST is required',
        invalid_type_error: 'DB_HOST must be a string',
      })
      .min(1, 'DB_HOST is required'),

    DB_PORT: z.coerce
      .number({
        invalid_type_error: 'DB_PORT must be a valid port number',
      })
      .int('DB_PORT must be an integer')
      .min(1, 'DB_PORT must be between 1 and 65535')
      .max(65535, 'DB_PORT must be between 1 and 65535')
      .default(5432),

    DB_USER: z
      .string({
        required_error: 'DB_USER is required',
        invalid_type_error: 'DB_USER must be a string',
      })
      .min(1, 'DB_USER is required'),

    DB_PASSWORD: z
      .string({
        required_error: 'DB_PASSWORD is required',
        invalid_type_error: 'DB_PASSWORD must be a string',
      })
      .min(1, 'DB_PASSWORD is required'),

    DB_NAME: z
      .string({
        required_error: 'DB_NAME is required',
        invalid_type_error: 'DB_NAME must be a string',
      })
      .min(1, 'DB_NAME is required'),

    JWT_SECRET: isTest
      ? z
          .string({
            required_error: 'JWT_SECRET is required',
            invalid_type_error: 'JWT_SECRET must be a string',
          })
          .min(1, 'JWT_SECRET is required')
      : z
          .string({
            required_error: 'JWT_SECRET is required',
            invalid_type_error: 'JWT_SECRET must be a string',
          })
          .min(1, 'JWT_SECRET is required')
          .min(32, 'JWT_SECRET must be at least 32 characters outside NODE_ENV=test'),

    CORS_ORIGINS: z
      .string({
        invalid_type_error: 'CORS_ORIGINS must be a string',
      })
      .optional(),

    ADMIN_TOKEN: z
      .string({
        invalid_type_error: 'ADMIN_TOKEN must be a string',
      })
      .optional(),

    NODE_ENV: z
      .string({
        invalid_type_error: 'NODE_ENV must be a string',
      })
      .optional()
      .default('development'),
  });
}

/**
 * Validates environment variables using Zod and returns a frozen configuration object.
 *
 * @param {Record<string, any>} [env=process.env] - Environment variables object.
 * @returns {Readonly<AppConfig>} Frozen configuration object with defaults applied.
 * @throws {Error} If one or more required environment variables are invalid or missing.
 */
export function loadConfig(env = process.env) {
  const rawEnv = env || {};
  const isTest = rawEnv.NODE_ENV === 'test';
  const schema = createEnvSchema(isTest);
  const result = schema.safeParse(rawEnv);

  if (!result.success) {
    const issuesByVar = new Map();
    for (const issue of result.error.issues) {
      const varName = issue.path.join('.') || 'env';
      if (!issuesByVar.has(varName)) {
        issuesByVar.set(varName, []);
      }
      issuesByVar.get(varName).push(issue.message);
    }

    const badVars = Array.from(issuesByVar.keys());
    const lines = [`Invalid environment configuration: ${badVars.join(', ')}`];
    for (const [varName, messages] of issuesByVar.entries()) {
      const uniqueMessages = [...new Set(messages)];
      lines.push(`  - ${varName}: ${uniqueMessages.join('; ')}`);
    }

    const error = new Error(lines.join('\n'));
    error.name = 'EnvError';
    error.invalidVariables = badVars;
    throw error;
  }

  return Object.freeze(result.data);
}

export default loadConfig;
