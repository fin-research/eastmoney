import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { resources, RESOURCE_GROUPS } from '../src/resources';

const schema = (value: z.ZodType, io: 'input' | 'output') => {
  const result = z.toJSONSchema(value, { io });
  delete result.$schema;
  return result;
};
const auth = [{ Auth0Bearer: [] }];
const paths: Record<string, unknown> = {};
for (const resource of resources) {
  const input = schema(resource.input, 'input');
  paths[resource.path] = { get: {
    operationId: resource.name, summary: resource.title, tags: [resource.group],
    ...(resource.login ? { security: auth, description: '要求 Gateway 验证的 Auth0 用户 Bearer JWT。机器访问须另行登记客户端、scope 与白名单；当前白名单为空。' } : {}),
    parameters: Object.entries(input.properties ?? {}).map(([name, property]) => ({
      name, in: resource.pathParameters.includes(name) ? 'path' : 'query',
      required: resource.pathParameters.includes(name) || input.required?.includes(name) || false,
      schema: property,
      ...(typeof property === 'object' && property.description ? { description: property.description } : {}),
    })),
    responses: {
      200: { description: 'Successful Response', content: { 'application/json': { schema: schema(resource.output, 'output') } } },
      ...(resource.login ? { 401: { description: '未登录或 Bearer JWT 失效（LOGIN_REQUIRED）' }, 403: { description: '已认证账号被拒绝或机器作用域不足（ACCESS_DENIED）' } } : {}),
      ...(resource.unavailable ? { 404: { $ref: '#/components/responses/ResourceNotAvailable' } } : {}),
      ...(resource.name === 'health' || resource.name === 'config' ? {} : { 429: { $ref: '#/components/responses/RateLimited' } }),
      422: { $ref: '#/components/responses/ValidationError' },
      503: { $ref: '#/components/responses/UpstreamError' },
    },
  } };
}
paths['/graphql'] = {
  get: { summary: 'GraphiQL', tags: ['服务'], responses: { 200: { description: 'GraphiQL HTML' } } },
  post: { summary: 'Thin GraphQL for all public data resources', tags: ['服务'], description: '公开资源可匿名查询；Choice 字段要求登录。混合查询保留公开数据并返回字段级 LOGIN_REQUIRED。', responses: { 200: { description: 'GraphQL Response' } } },
};
const document = {
  openapi: '3.1.0',
  info: { title: '东方财富市场数据 API', version: '0.6.0', description: '按资源来源分组的强类型 REST、GraphQL 与 MCP。保护资源使用 Gateway 验证的 Auth0 API Bearer JWT。Authorize 填写 Bearer token；登录 Cookie 不作凭据。公开资源不要求登录。' },
  servers: [{ url: '/data', description: '本站 Gateway Data API' }],
  tags: RESOURCE_GROUPS,
  security: [],
  components: {
    securitySchemes: {
      Auth0Bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Auth0 签发的本站 API access token。' },
    },
    schemas: {
      Error: {
        type: "object",
        additionalProperties: false,
        required: ["detail"],
        properties: {
          detail: { type: "string" },
          error: {
            type: "object",
            additionalProperties: false,
            required: ["code"],
            properties: {
              code: { type: "string" },
              source: { type: "string" },
              stage: { type: "string" },
              upstreamStatus: { type: "integer" },
              upstreamPath: { type: "string" },
              issues: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["path", "code", "message", "receivedType"],
                  properties: {
                    path: { type: "string" },
                    code: { type: "string" },
                    message: { type: "string" },
                    receivedType: { type: "string" },
                    receivedValue: {
                      type: ["string", "number", "boolean", "null"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      RateLimited: {
        description: "Upstream rate limit exceeded (RATE_LIMITED)",
        headers: { "Retry-After": { description: "Seconds before retry", schema: { type: "string", example: "60" } } },
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      ValidationError: {
        description: "Validation Error",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      UpstreamError: {
        description: "Upstream Error",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      ResourceNotAvailable: {
        description: "Resource Not Available Yet",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
  },
  paths,
};
await writeFile(new URL('../src/openapi.json', import.meta.url), JSON.stringify(document) + '\n', 'utf8');
