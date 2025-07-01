const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const postSchema = new Schema({
  SOL_ID: { type: String, required: false },
  DEV_ID: { type: String, required: false },
  userId: { type: String, required: true },
  username: { type: String, required: true },
  postId: { type: String, required: true, unique: true },
  content: { type: String, required: true },
  project: { type: [String], required: true },
  score: { type: Number, required: true },
  blabz: { type: Number, required: true },
  likes: { type: Number, default: 0 },
  retweets: { type: Number, default: 0 },
  replies: { type: Number, default: 0 },
  hashtags: { type: [String], default: [] },
  tweetUrl: { type: String, required: true },
  createdAt: { type: Date, required: true },
  tweetType: { type: String, required: true, enum: ['main', 'quote', 'replied_to'] },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Post', postSchema);
