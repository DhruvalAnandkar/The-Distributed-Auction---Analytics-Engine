import bcrypt from 'bcryptjs';
import pool from '../config/db.js';

export const registerUser = async (req, res) => {
  // 1. Extract the data the user sent in the request body
  const {username, email, password} = req.body;
  try{
    //2. Security Check: Make sure the email or username doesn't already exist 
    const userExists = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );
    if(userExists.rows.length > 0){
      return res.status(400).json({ error: ' Username or email already in use.'});
    }
    //3. Cryptography: Generate a " salt" and hash the password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    //4. Database Insertion: Save the user safely 
    // Note: We use $1, $2, $3 to prevent SQL Injection attacks 
    const newUser = await pool.query(
      `INSERT INTO users (username, email, password)
      VALUES($1, $2, $3) 
      RETURNING id, username, email, created_at`,
      [username, email, hashedPassword]
    );
    // 5. Send back the successfull response(NEVER send the password back!)
    res.status(201).json({
      message: 'User registered successfully',
      user: newUser.rows[0]
    });
  } 
  catch(err){
    console.error(`[Register User Error] ${err.message}`);
    res.status(500).json({
      error: 'Internal server error',
      message: err.message || 'An unexpected error occurred'          
    });
  }
  };
