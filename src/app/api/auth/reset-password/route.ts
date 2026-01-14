import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { User } from '@/lib/models/user';
import { PasswordReset } from '@/lib/models/password-reset';
import bcrypt from 'bcryptjs';

export async function POST(req: NextRequest) {
  try {
    const { token, password } = await req.json();

    if (!token || !password) {
      return NextResponse.json(
        { error: 'Token and password are required' },
        { status: 400 }
      );
    }

    if (password.length < 6) {
      return NextResponse.json(
        { error: 'Password must be at least 6 characters long' },
        { status: 400 }
      );
    }

    await connectDB();

    // Find the reset token
    const resetToken = await PasswordReset.findOne({ token });

    if (!resetToken) {
      return NextResponse.json(
        { error: 'Invalid or expired reset token' },
        { status: 400 }
      );
    }

    // Check if token has expired
    if (resetToken.expiresAt < new Date()) {
      await PasswordReset.deleteOne({ _id: resetToken._id });
      return NextResponse.json(
        { error: 'Reset token has expired' },
        { status: 400 }
      );
    }

    // Find the user
    const user = await User.findById(resetToken.userId);

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Update user's password
    user.password = hashedPassword;
    await user.save();

    // Delete the used reset token
    await PasswordReset.deleteOne({ _id: resetToken._id });

    return NextResponse.json({
      message: 'Password has been reset successfully',
    });
  } catch (error: any) {
    console.error('Reset password error:', error);
    return NextResponse.json(
      { error: 'An error occurred resetting your password' },
      { status: 500 }
    );
  }
}
