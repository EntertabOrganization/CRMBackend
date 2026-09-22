import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { AuthDomainService } from './auth-domain.service';
import { currentUserId, ok } from './http-utils';

@Controller('auth')
export class AuthHttpController {
  constructor(private readonly auth: AuthDomainService) {}

  @Post('signup')
  @HttpCode(200)
  signup(@Body() body: { firstName: string; lastName: string; email: string; password: string }) {
    return ok(this.auth.signup(body));
  }

  @Post('verify-email')
  @HttpCode(200)
  verifyEmail(@Body() body: { token: string }) {
    return ok(this.auth.verifyEmail(body.token));
  }

  @Post('resend-verification')
  @HttpCode(200)
  resendVerification(@Body() body: { email: string }) {
    return ok(this.auth.resendVerification(body.email));
  }

  @Post('signin')
  @HttpCode(200)
  signin(@Body() body: { email: string; password: string }) {
    return ok(this.auth.signin(body));
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: { refreshToken: string }) {
    return ok(this.auth.refresh(body.refreshToken));
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Body() body: { refreshToken: string }) {
    this.auth.logout(body.refreshToken);
    return ok(null);
  }

  @Post('logout-all')
  @HttpCode(200)
  logoutAll(@Req() req: any) {
    this.auth.logoutAll(currentUserId(this.auth, req));
    return ok(null);
  }

  @Post('forgot-password')
  @HttpCode(200)
  forgotPassword(@Body() body: { email: string }) {
    return ok(this.auth.forgotPassword(body.email));
  }

  @Post('reset-password')
  @HttpCode(200)
  resetPassword(@Body() body: { token: string; password: string }) {
    this.auth.resetPassword(body.token, body.password);
    return ok(null);
  }

  @Post('google/signup')
  @HttpCode(200)
  googleSignup(@Body() body: { credential: string }) {
    return this.auth.googleAuth(body.credential).then(ok);
  }

  @Post('google/signin')
  @HttpCode(200)
  googleSignin(@Body() body: { credential: string }) {
    return this.auth.googleAuth(body.credential).then(ok);
  }

  @Get('me')
  me(@Req() req: any) {
    return ok(this.auth.me(currentUserId(this.auth, req)));
  }
}
