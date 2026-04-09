# Domain: API (Endpoints/Routing)

## Core Principles
- Follow RESTful conventions (appropriate HTTP methods, status codes)
- Error responses use a consistent format (status, message, details)
- Auth/authorization middleware must be explicit in route definitions
- Request validation is performed immediately upon handler entry

## Cautions
- Check for breaking changes (backward compatibility with existing clients)
- Watch for missing rate limiting and CORS configuration
- Pagination is required for large responses
- Sensitive data must be excluded from responses (password, token, etc.)

## Verification Points
- Do all endpoints return appropriate HTTP status codes?
- Are error cases (400, 401, 403, 404, 409, 500) handled?
- Is there request body/query validation?
- Does it match the OpenAPI/Swagger documentation?
