import nodemailer from "nodemailer";
import type { Config } from "./config.js";
export interface Email {
  recipient: string;
  subject: string;
  body: string;
}
export type EmailSender = (email: Email) => Promise<void>;
export function createEmailSender(
  smtp: Config["smtp"],
): EmailSender | undefined {
  if (!smtp) return undefined;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  return async ({ recipient, subject, body }) => {
    await transport.sendMail({
      from: smtp.from,
      to: recipient,
      subject,
      text: body,
    });
  };
}
