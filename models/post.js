const mongoose = require('mongoose');
const PostSchema = new mongoose.Schema({
  SOL_ID: String,
  DEV_ID: String,
  userId: String,
  username: String,
  postId: { type: String, unique: true, index: true },
  content: String,
  project: [String],
  score: Number,
  blabz: Number,
  likes: Number,
  retweets: Number,
  replies: Number,
  hashtags: [String],
  tweetUrl: String,
  createdAt: Date,
  tweetType: String
});
module.exports = mongoose.model('Post', PostSchema);
