// Day 4
import bycrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../config/db.js';
export const registerUser = async (req, res) => {
  res.status(200).json({ message: 'User registered successfully' 

  });
};
