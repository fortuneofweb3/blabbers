const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const routes = require('./routes/api');

const app = express();

app.use(express.json());
app.use(cors());
app.use('/solcontent', routes);

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('[MongoDB] Connected'))
  .catch(err => console.error('[MongoDB] Connection error:', err));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
