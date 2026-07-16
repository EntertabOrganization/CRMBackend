import { BadRequestException } from '@nestjs/common';
import { MediaType } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

export const FIELD_MEDIA_UPLOAD_DIR = 'uploads/field-media';
export const FORM_LOGO_UPLOAD_DIR = 'uploads/form-logos';

export type UploadedMedia = {
  url: string;
  type: MediaType;
};

export function resolveMediaType(mimetype: string): MediaType {
  if (mimetype.startsWith('image/')) {
    return MediaType.IMAGE;
  }
  if (mimetype.startsWith('video/')) {
    return MediaType.VIDEO;
  }
  if (mimetype.startsWith('audio/')) {
    return MediaType.AUDIO;
  }
  return MediaType.DOCUMENT;
}

export function saveFieldMediaFile(media: { originalname: string; mimetype: string; buffer: Buffer }): UploadedMedia {
  const uploadDir = path.join(process.cwd(), FIELD_MEDIA_UPLOAD_DIR);
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const safeName = media.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
  const fileName = `${Date.now()}-${safeName}`;
  const filePath = path.join(uploadDir, fileName);
  fs.writeFileSync(filePath, media.buffer);

  return {
    url: `/${FIELD_MEDIA_UPLOAD_DIR}/${fileName}`,
    type: resolveMediaType(media.mimetype),
  };
}

export function saveFormLogoFile(media: { originalname: string; mimetype: string; buffer: Buffer }): string {
  if (!media.mimetype.startsWith('image/')) {
    throw new BadRequestException('Only image files are allowed for form logo');
  }

  const uploadDir = path.join(process.cwd(), FORM_LOGO_UPLOAD_DIR);
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const safeName = media.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
  const fileName = `${Date.now()}-${safeName}`;
  const filePath = path.join(uploadDir, fileName);
  fs.writeFileSync(filePath, media.buffer);

  return `/${FORM_LOGO_UPLOAD_DIR}/${fileName}`.replace(/\\/g, '/');
}

export function applyLogoFromFiles(dto: { logoPath?: string }, files: any[] = []): void {
  const logo = files.find((file) => file.fieldname === 'logo');
  if (logo) {
    dto.logoPath = saveFormLogoFile(logo);
  }
}

export function toPublicUploadPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export function buildFieldMediaMap(files: any[] = []): Map<string, any> {
  const map = new Map<string, any>();
  const prefix = 'fieldMedia_';

  for (const file of files) {
    if (file.fieldname.startsWith(prefix)) {
      map.set(file.fieldname.slice(prefix.length), file);
    }
  }

  return map;
}
