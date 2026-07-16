import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { Request } from 'express';

const JWT_SECRET_ENV = 'JWT_SECRET';
const FALLBACK_SECRET = 'test-jwt-secret-for-local-dev-only';

/** Verifies the Bearer JWT in Authorization and sets req.userId from the token subject. */
@Injectable()
export class JwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { userId: string }>();

    // Extract and validate Bearer token presence
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }
    const token = auth.slice('Bearer '.length);

    // Verify signature and expiry; attach subject to request for downstream use
    try {
      const payload = jwt.verify(
        token,
        process.env[JWT_SECRET_ENV] ?? FALLBACK_SECRET,
      ) as jwt.JwtPayload;
      req.userId = payload.sub ?? '';
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    return true;
  }
}
