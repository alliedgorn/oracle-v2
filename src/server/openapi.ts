import { createRoute, z } from '@hono/zod-openapi';

export const healthRoute = createRoute({
  method: 'get',
  path: '/api/health',
  tags: ['system'],
  summary: 'Server health check',
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ status: z.string(), server: z.string(), port: z.number(), oracleV2: z.string() }) } },
      description: 'Server is healthy',
    },
  },
});

export const authStatusRoute = createRoute({
  method: 'get',
  path: '/api/auth/status',
  tags: ['auth'],
  summary: 'Check if session is authenticated',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            authenticated: z.boolean(),
            authEnabled: z.boolean(),
            hasPassword: z.boolean().optional(),
            localBypass: z.boolean().optional(),
            isLocal: z.boolean().optional(),
            role: z.string().optional(),
            guestName: z.string().optional(),
            guestUsername: z.string().optional(),
          }),
        },
      },
      description: 'Auth status response',
    },
  },
});

export const authLoginRoute = createRoute({
  method: 'post',
  path: '/api/auth/login',
  tags: ['auth'],
  summary: 'Login with password',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            password: z.string(),
            username: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
      description: 'Login successful',
    },
    401: {
      content: { 'application/json': { schema: z.object({ success: z.boolean(), error: z.string() }) } },
      description: 'Invalid credentials',
    },
    429: {
      content: { 'application/json': { schema: z.object({ success: z.boolean(), error: z.string() }) } },
      description: 'Rate limited',
    },
  },
});

export const authLogoutRoute = createRoute({
  method: 'post',
  path: '/api/auth/logout',
  tags: ['auth'],
  summary: 'Logout current session',
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
      description: 'Logout successful',
    },
  },
});

export const OPENAPI_INFO = {
  openapi: '3.0.0' as const,
  info: {
    title: 'Den Book API',
    version: '1.0.0',
    description: 'Internal API for Den Book — Beast communication, forum, tasks, and village life.',
  },
};
