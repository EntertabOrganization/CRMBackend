import { appendFileSync, readFileSync } from 'node:fs';
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

  private record(mail: SentMail) {
    this.sent.push(mail);
    const mailbox = process.env.TEST_MAILBOX_FILE;
    if (mailbox) appendFileSync(mailbox, `${JSON.stringify(mail)}\n`, { encoding: 'utf8' });
  }

  async sendVerificationEmail(to: string, token: string) {
    this.record({ to, subject: 'Verify your EntertabCRM email', token });
  }

  async sendPasswordResetEmail(to: string, token: string) {
    this.record({ to, subject: 'Reset your EntertabCRM password', token });
  }

  async sendInvitationEmail(to: string, token: string) {
    this.record({ to, subject: 'EntertabCRM workspace invitation', token });
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
    let profile = this.profiles.get(credential);
    const fixturePath = process.env.TEST_GOOGLE_PROFILES_FILE;
    if (!profile && fixturePath) {
      try {
        const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, GoogleProfile>;
        profile = fixtures[credential];
      } catch {
        profile = undefined;
      }
    }
    if (!profile) throw unauthorized('Invalid Google credential.');
    return profile;
  }
}
