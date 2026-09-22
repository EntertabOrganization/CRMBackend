import { unauthorized } from './errors';

export type SentMail = {
  to: string;
  subject: string;
  token?: string;
};

export interface MailService {
  sendVerificationEmail(to: string, token: string): Promise<void>;
  sendPasswordResetEmail(to: string, token: string): Promise<void>;
  sendInvitationEmail(to: string, token: string): Promise<void>;
}

export class MemoryMailService implements MailService {
  sent: SentMail[] = [];

  async sendVerificationEmail(to: string, token: string) {
    this.sent.push({ to, subject: 'Verify your EntertabCRM email', token });
  }

  async sendPasswordResetEmail(to: string, token: string) {
    this.sent.push({ to, subject: 'Reset your EntertabCRM password', token });
  }

  async sendInvitationEmail(to: string, token: string) {
    this.sent.push({ to, subject: 'EntertabCRM workspace invitation', token });
  }
}

export type GoogleProfile = {
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  firstName: string;
  lastName: string;
};

export interface GoogleAuthProvider {
  verifyCredential(credential: string): Promise<GoogleProfile>;
}

export class FakeGoogleAuthProvider implements GoogleAuthProvider {
  constructor(private readonly profiles = new Map<string, GoogleProfile>()) {}

  addCredential(credential: string, profile: GoogleProfile) {
    this.profiles.set(credential, profile);
  }

  async verifyCredential(credential: string) {
    const profile = this.profiles.get(credential);
    if (!profile) throw unauthorized('Invalid Google credential.');
    return profile;
  }
}
