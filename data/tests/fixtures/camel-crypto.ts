import { encryptCamelPassword } from '../../src/camel/client';
export default {
  async fetch(request: Request) {
    const body = await request.json() as { password: string; key: string };
    return Response.json({ encrypted: encryptCamelPassword(body.password, body.key) });
  },
};
