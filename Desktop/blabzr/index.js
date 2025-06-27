const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();
const apiRoutes = require('./routes/api');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('[MongoDB] Connected');
}).catch(err => {
  console.error('[MongoDB] Connection error:', err.message);
});

app.use('/solcontent', apiRoutes);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

mongoose.set('strictQuery', true);