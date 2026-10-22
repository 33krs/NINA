import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { AppController } from '../../app.controller';

@Injectable()
export class AccessBoundaryGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (
      context.getType() === 'http' &&
      context.getClass() === AppController &&
      context.getHandler() === AppController.prototype.getHealthCheck &&
      context.switchToHttp().getRequest<{ method?: unknown }>().method === 'GET'
    ) {
      return true;
    }
    // Temporary: replace with verified identity AND accepted resource policy.
    throw new UnauthorizedException();
  }
}
