import { Body, Controller, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../../common/decorators/public.decorator';
import { resolveSensitiveThrottleConfig } from '../../../config/throttler.config';
import { GoogleAuthDto, SignInDto, SignUpDto } from '../dto/auth.dto';
import { AuthService } from '../services/auth.service';

const sensitiveThrottleConfig = resolveSensitiveThrottleConfig();

@ApiTags('Auth')
@Public()
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @ApiOperation({ summary: 'Sign up a new user with optional company creation' })
  @ApiResponse({ status: 201, description: 'User signed up successfully.' })
  @ApiResponse({ status: 409, description: 'Email already exists.' })
  @ApiBody({ type: SignUpDto })
  @ApiConsumes('multipart/form-data')
  @Post('signup')
  @UseInterceptors(FileFieldsInterceptor([
    { name: 'profilePic', maxCount: 1 },
    { name: 'logo', maxCount: 1 },
  ], {
    dest: './uploads',
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) {
        return cb(new Error('Only image files are allowed!'), false);
      }
      cb(null, true);
    },
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  }))
  @Throttle({ default: sensitiveThrottleConfig })
  signup(
    @Body() signUpDto: SignUpDto,
    @UploadedFiles() files: any,
  ) {
    if (files?.profilePic?.[0]) {
      signUpDto.profilePic = files.profilePic[0].path.replace(/\\/g, '/');
    }
    if (files?.logo?.[0]) {
      signUpDto.logo = files.logo[0].path.replace(/\\/g, '/');
    }
    return this.authService.signup(signUpDto);
  }

  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiResponse({ status: 200, description: 'User signed in successfully.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  @Post('signin')
  @Throttle({ default: sensitiveThrottleConfig })
  signin(@Body() signInDto: SignInDto) {
    return this.authService.signin(signInDto);
  }

  @ApiOperation({ summary: 'Sign in with Google' })
  @ApiResponse({ status: 422, description: 'Google auth is not configured.' })
  @Post('google/signin')
  @Throttle({ default: sensitiveThrottleConfig })
  googleSignin(@Body() googleAuthDto: GoogleAuthDto) {
    return this.authService.googleSignin(googleAuthDto);
  }

  @ApiOperation({ summary: 'Sign up with Google' })
  @ApiResponse({ status: 422, description: 'Google auth is not configured.' })
  @Post('google/signup')
  @Throttle({ default: sensitiveThrottleConfig })
  googleSignup(@Body() googleAuthDto: GoogleAuthDto) {
    return this.authService.googleSignup(googleAuthDto);
  }

  @ApiOperation({ summary: 'Refresh access token using refresh token' })
  @ApiResponse({ status: 200, description: 'New tokens generated successfully.' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token.' })
  @Post('refresh')
  @Throttle({ default: sensitiveThrottleConfig })
  refresh(@Body() body: { refreshToken: string }) {
    return this.authService.refreshTokens(body.refreshToken);
  }
}
