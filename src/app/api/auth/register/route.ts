import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { User } from '@/lib/models/user';
import bcrypt from 'bcryptjs';

export async function POST(req: NextRequest) {
  try {
    const { email, password, name } = await req.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email y contraseña son requeridos' },
        { status: 400 }
      );
    }

    await connectDB();

    // Verificar si el usuario ya existe
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return NextResponse.json(
        { error: 'El usuario ya existe' },
        { status: 400 }
      );
    }

    // Hashear contraseña
    const hashedPassword = await bcrypt.hash(password, 10);

    // Simplificación: si name viene como string, lo ponemos en first.
    // Si viene como objeto, lo usamos tal cual (suponiendo que el cliente mande estructura correcta,
    // o hacemos un parseo básico).
    let nameObj = {
        first: '',
        middle: '',
        last: ''
    };

    if (typeof name === 'string') {
        // Intento básico de separar nombre y apellido
        const parts = name.split(' ');
        if (parts.length === 1) {
            nameObj.first = parts[0];
        } else if (parts.length > 1) {
            nameObj.first = parts[0];
            nameObj.last = parts.slice(1).join(' ');
        }
    } else if (typeof name === 'object' && name !== null) {
        nameObj = { ...nameObj, ...name };
    } else {
        nameObj.first = 'Usuario'; // Fallback
    }
    
    // Crear usuario
    const user = await User.create({
      email,
      name: nameObj,
      password: hashedPassword,
    });

    return NextResponse.json({
      message: 'Usuario creado exitosamente',
      user: {
        id: user._id,
        email: user.email,
        name: user.name, // Esto debería incluir el virtual si toJSON está configurado, o devolvemos user.toObject()
      },
    });
  } catch (error: any) {
    console.error('Error de registro:', error);
    return NextResponse.json(
      { error: 'Error al registrar usuario' },
      { status: 500 }
    );
  }
}
