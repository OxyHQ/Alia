import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { User } from '@/lib/models/user';
import { PasswordReset } from '@/lib/models/password-reset';
import crypto from 'crypto';

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();

    if (!email) {
      return NextResponse.json(
        { error: 'Email is required' },
        { status: 400 }
      );
    }

    await connectDB();

    const user = await User.findOne({ email });

    // Always return success even if user doesn't exist (security best practice)
    // This prevents email enumeration attacks
    if (!user) {
      return NextResponse.json({
        message: 'If an account with that email exists, a password reset link has been sent.',
      });
    }

    // Generate a secure random token
    const token = crypto.randomBytes(32).toString('hex');

    // Token expires in 1 hour
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // Delete any existing reset tokens for this user
    await PasswordReset.deleteMany({ userId: user._id.toString() });

    // Create new reset token
    await PasswordReset.create({
      userId: user._id.toString(),
      token,
      expiresAt,
    });

    // TODO: Send email with reset link
    // For now, we'll just return the token in development
    // In production, you should send an email with a link like:
    // const resetUrl = `${process.env.NEXTAUTH_URL}/reset-password?token=${token}`;
    // await sendPasswordResetEmail(user.email, resetUrl);

    console.log(`Password reset token for ${email}: ${token}`);
    console.log(`Reset URL: ${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/reset-password?token=${token}`);

    return NextResponse.json({
      message: 'If an account with that email exists, a password reset link has been sent.',
      // Remove this in production - only for development
      ...(process.env.NODE_ENV === 'development' && {
        resetUrl: `/reset-password?token=${token}`
      }),
    });
  } catch (error: any) {
    console.error('Forgot password error:', error);
    return NextResponse.json(
      { error: 'An error occurred processing your request' },
      { status: 500 }
    );
  }
}
