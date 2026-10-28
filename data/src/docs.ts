import openapi from "./openapi.json";

import { jsonResponse, textResponse } from "./http";

const TITLE = "东方财富市场数据 API";

function swaggerHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${TITLE} - Swagger UI</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>const ui = SwaggerUIBundle({url: '/data/openapi.json',dom_id:'#swagger-ui',deepLinking:true,displayRequestDuration:true,persistAuthorization:false,withCredentials:true});</script>
</body></html>`;
}

function redocHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${TITLE} - ReDoc</title></head>
<body><redoc spec-url="/data/openapi.json"></redoc>
<script src="https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js"></script></body></html>`;
}

export function handleDocs(pathname: string): Response | null {
  if (pathname === "/openapi.json") return jsonResponse(openapi);
  if (pathname === "/docs") return textResponse(swaggerHtml(), "text/html; charset=utf-8");
  if (pathname === "/redoc") return textResponse(redocHtml(), "text/html; charset=utf-8");
  return null;
}
