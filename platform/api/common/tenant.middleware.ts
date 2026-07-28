/**
 * Resolves the authenticated transporter from the bearer token and pins it
 * to the request. In production this validates a JWT (issued by your auth
 * flow); the transporter_id claim becomes the RLS tenant for every query.
 */
import { Injectable, NestMiddleware, UnauthorizedException } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { createHmac } from "crypto";

export interface TenantRequest extends Request {
  transporterId: string;
  userId: string;
}

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: TenantRequest, _res: Response, next: NextFunction) {
    // Webhooks authenticate by signature, not bearer token.
    if (req.path.startsWith("/payments/webhook")) return next();

    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) throw new UnauthorizedException();

    const token = auth.slice(7);
    const payload = this.verifyJwt(token); // { sub, transporter_id }
    req.userId = payload.sub;
    req.transporterId = payload.transporter_id;
    next();
  }

  private verifyJwt(token: string): { sub: string; transporter_id: string } {
    const [h, p, sig] = token.split(".");
    if (!h || !p || !sig) throw new UnauthorizedException();
    const expected = createHmac("sha256", process.env.JWT_SECRET!)
      .update(`${h}.${p}`)
      .digest("base64url");
    if (sig !== expected) throw new UnauthorizedException();
    return JSON.parse(Buffer.from(p, "base64url").toString());
  }
}