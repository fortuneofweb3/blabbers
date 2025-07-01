const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Post = require('../models/post');
const ProcessedPost = require('../models/processedpost');
const Project = require('../models/project');
const User = require('../models/user');

const router = express.Router();

if (!process.env.X_BEARER_TOKEN || typeof process.env.X_BEARER_TOKEN !== 'string') {
  throw new Error('[API] X_BEARER_TOKEN is not set or invalid');
}
console.log('[API] Twitter API Bearer Token configured');

router.use(cors());

// Global rate limit tracking
let rateLimitUntil = null;

function isValidSolanaAddress(address) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function isValidDevId(devId) {
  return /^[a-zA-Z0-9_-]{8,64}$/.test(devId);
}

function isValidDate(dateString) {
  return !isNaN(new Date(dateString).getTime());
}

function extractHashtags(text) {
  const hashtags = [];
  const regex = /#(\w+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    hashtags.push(match[1]);
  }
  return hashtags;
}

function extractMentions(text) {
  const regex = /@(\w+)/g;
  let mentionChars = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    mentionChars += match[0].length;
  }
  return mentionChars;
}

function calculateQualityScore(tweet, followersCount) {
  const lengthScore = Math.min(Math.max((tweet.text.length - 50) / 200, 0), 1);
  const { like_count, retweet_count, quote_count } = tweet.public_metrics || {};
  const engagementRaw = like_count + 2 * retweet_count + 3 * quote_count;
  const engagementScore = Math.min(engagementRaw / Math.max(1, followersCount), 1);
  const combinedScore = 0.5 * 0.5 + 0.25 * lengthScore + 0.25 * engagementScore;
  return Math.round(combinedScore * 99) + 1;
}

function calculateBlabzPerProject(qualityScore) {
  return (qualityScore / 300).toFixed(4);
}

async function fetchTwitterUser(username) {
  if (rateLimitUntil && rateLimitUntil > new Date()) {
    throw { response: { status: 429 } };
  }
  console.log(`[API] Attempting Twitter API call for username: ${username}`);
  const response = await axios.get(`https://api.twitter.com/2/users/by/username/${username}`, {
    headers: {
      Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
      'Content-Type': 'application/json'
    },
    params: {
      'user.fields': 'id,name,username,profile_image_url,public_metrics'
    }
  }).catch(err => {
    if (err.response?.status === 429) {
      rateLimitUntil = new Date(Date.now() + 15 * 60 * 1000);
      console.log(`[API] Rate limit hit, pausing until ${rateLimitUntil}`);
    }
    throw err;
  });
  console.log('[API] Twitter API response:', response.data);
  return response.data.data;
}

router.post('/users', async (req, res) => {
  try {
    const { username, SOL_ID, DEV_ID } = req.body;
    if (!username || !SOL_ID || !DEV_ID) {
      return res.status(400).json({ error: 'username, SOL_ID, and DEV_ID required' });
    }
    if (!isValidSolanaAddress(SOL_ID)) {
      return res.status(400).json({ error: 'Invalid SOL_ID' });
    }
    if (!isValidDevId(DEV_ID)) {
      return res.status(400).json({ error: 'Invalid DEV_ID' });
    }

    const existingUser = await User.findOne({
      $or: [{ SOL_ID, username: { $ne: username } }, { DEV_ID, username: { $ne: username } }]
    });
    if (existingUser) {
      return res.status(400).json({ error: 'SOL_ID or DEV_ID already used' });
    }

    console.log(`[API] Fetching Twitter user: ${username}`);
    let twitterUser;
    try {
      twitterUser = await fetchTwitterUser(username);
      if (!twitterUser) {
        return res.status(404).json({ error: 'Twitter user not found' });
      }
    } catch (err) {
      if (err.response?.status === 429) {
        const cachedUser = await User.findOne({ username }).lean();
        if (cachedUser) {
          console.log('[API] Using cached user data');
          return res.json({
            message: `User ${username} retrieved from cache`,
            user: {
              SOL_ID: cachedUser.SOL_ID || '',
              DEV_ID: cachedUser.DEV_ID || '',
              userId: cachedUser.userId,
              username: cachedUser.username,
              name: cachedUser.name,
              profile_image_url: cachedUser.profile_image_url,
              followers_count: cachedUser.followers_count,
              following_count: cachedUser.following_count
            },
            warning: 'Using cached data due to Twitter API rate limit'
          });
        }
        return res.status(503).json({ 
          error: 'Service temporarily unavailable', 
          details: 'Twitter API rate limit exceeded, no cached data available' 
        });
      }
      throw err;
    }

    const userData = {
      SOL_ID,
      DEV_ID,
      userId: twitterUser.id,
      username: twitterUser.username,
      name: twitterUser.name || '',
      profile_image_url: twitterUser.profile_image_url || '',
      followers_count: twitterUser.public_metrics?.followers_count || 0,
      following_count: twitterUser.public_metrics?.following_count || 0,
      updatedAt: new Date()
    };

    const user = await User.findOneAndUpdate(
      { username },
      { $set: userData },
      { upsert: true, new: true }
    );
    console.log(`[MongoDB] User ${username} saved:`, user);
    res.json({ message: `User ${username} saved`, user });
  } catch (err) {
    console.error('[API] POST /users error:', err.response?.status, err.message, err.stack);
    res.status(err.response?.status || 500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/user-details/:username', async (req, res) => {
  try {
    console.log(`[API] Fetching user: ${req.params.username}`);
    const cachedUser = await User.findOne({ username: req.params.username }).lean();
    if (cachedUser && cachedUser.updatedAt > new Date(Date.now() - 15 * 60 * 1000)) {
      console.log('[API] Using fresh cached user data');
      return res.json({
        SOL_ID: cachedUser.SOL_ID || '',
        DEV_ID: cachedUser.DEV_ID || '',
        userId: cachedUser.userId,
        username: cachedUser.username,
        name: cachedUser.name,
        profile_image_url: cachedUser.profile_image_url,
        followers_count: cachedUser.followers_count,
        following_count: cachedUser.following_count
      });
    }

    let twitterUser;
    try {
      twitterUser = await fetchTwitterUser(req.params.username);
      if (!twitterUser) {
        return res.status(404).json({ error: 'User not found' });
      }
    } catch (err) {
      if (err.response?.status === 429) {
        if (cachedUser) {
          console.log('[API] Using cached user data');
          return res.json({
            SOL_ID: cachedUser.SOL_ID || '',
            DEV_ID: cachedUser.DEV_ID || '',
            userId: cachedUser.userId,
            username: cachedUser.username,
            name: cachedUser.name,
            profile_image_url: cachedUser.profile_image_url,
            followers_count: cachedUser.followers_count,
            following_count: cachedUser.following_count,
            warning: 'Using cached data due to Twitter API rate limit'
          });
        }
        return res.status(503).json({ 
          error: 'Service temporarily unavailable', 
          details: 'Twitter API rate limit exceeded, no cached data available' 
        });
      }
      throw err;
    }

    const userData = {
      userId: twitterUser.id,
      username: twitterUser.username,
      name: twitterUser.name || '',
      profile_image_url: twitterUser.profile_image_url || '',
      followers_count: twitterUser.public_metrics?.followers_count || 0,
      following_count: twitterUser.public_metrics?.following_count || 0,
      updatedAt: new Date()
    };
    const userDoc = await User.findOneAndUpdate(
      { userId: twitterUser.id },
      { $set: userData },
      { upsert: true, new: true }
    ).lean();
    console.log('[API] MongoDB userDoc updated:', userDoc);

    res.json({
      SOL_ID: userDoc.SOL_ID || '',
      DEV_ID: userDoc.DEV_ID || '',
      userId: twitterUser.id,
      username: twitterUser.username,
      name: twitterUser.name,
      profile_image_url: twitterUser.profile_image_url,
      followers_count: twitterUser.public_metrics.followers_count,
      following_count: twitterUser.public_metrics.following_count
    });
  } catch (err) {
    console.error('[API] GET /user-details error:', err.response?.status, err.message, err.stack);
    res.status(err.response?.status || 500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/rate-limit-status', async (req, res) => {
  try {
    console.log('[API] Checking Twitter API rate limit status');
    if (rateLimitUntil && rateLimitUntil > new Date()) {
      return res.json({ 
        message: 'Rate limit active', 
        rateLimit: {
          remaining: 0,
          reset: rateLimitUntil
        }
      });
    }

    let response;
    try {
      response = await axios.get('https://api.twitter.com/2/users/by', {
        headers: {
          Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
          'Content-Type': 'application/json'
        },
        params: {
          usernames: 'test',
          'user.fields': 'id'
        }
      });
    } catch (err) {
      if (err.response?.status === 429) {
        rateLimitUntil = new Date(Date.now() + 15 * 60 * 1000);
        console.log(`[API] Rate limit hit, pausing until ${rateLimitUntil}`);
        return res.json({ 
          message: 'Rate limit active', 
          rateLimit: {
            remaining: 0,
            reset: rateLimitUntil
          }
        });
      }
      throw err;
    }

    console.log('[API] Rate limit check response:', response.headers);
    res.json({ 
      message: 'Rate limit check', 
      rateLimit: {
        limit: response.headers['x-rate-limit-limit'],
        remaining: response.headers['x-rate-limit-remaining'],
        reset: new Date(parseInt(response.headers['x-rate-limit-reset']) * 1000)
      }
    });
  } catch (err) {
    console.error('[API] Rate limit check error:', err.response?.status, err.message, err.stack);
    res.status(err.response?.status || 500).json({ 
      error: 'Rate limit check failed', 
      details: err.message 
    });
  }
});

router.post('/projects', async (req, res) => {
  try {
    const { name, keywords, description, twitterUsername, userId, profile_image_url, displayName, followers_count, following_count } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name required' });
    }
    const projectData = {
      name: name.toUpperCase(),
      displayName: displayName || '',
      keywords: keywords || [],
      description: description || '',
      twitterUsername: twitterUsername || '',
      userId: userId || '',
      profile_image_url: profile_image_url || '',
      followers_count: followers_count || 0,
      following_count: following_count || 0,
      updatedAt: new Date()
    };
    const project = await Project.findOneAndUpdate(
      { name: name.toUpperCase() },
      { $set: projectData },
      { upsert: true, new: true }
    );
    console.log(`[MongoDB] Project ${name} saved:`, project);
    res.json({ message: `Project ${name} added`, project });
  } catch (err) {
    console.error('[API] POST /projects error:', err.message, err.stack);
    res.status(400).json({ error: 'Server error', details: err.message });
  }
});

router.put('/project/:project', async (req, res) => {
  try {
    const { keywords, description, twitterUsername, userId, profile_image_url, displayName, followers_count, following_count } = req.body;
    const projectData = {
      name: req.params.project.toUpperCase(),
      displayName: displayName || '',
      keywords: keywords || [],
      description: description || '',
      twitterUsername: twitterUsername || '',
      userId: userId || '',
      profile_image_url: profile_image_url || '',
      followers_count: followers_count || 0,
      following_count: following_count || 0,
      updatedAt: new Date()
    };
    const project = await Project.findOneAndUpdate(
      { name: req.params.project.toUpperCase() },
      { $set: projectData },
      { new: true }
    );
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    console.log(`[MongoDB] Project ${req.params.project} updated:`, project);
    res.json({ message: `Project ${req.params.project} updated`, project });
  } catch (err) {
    console.error('[API] PUT /project error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.post('/projects/:twitterUsername', async (req, res) => {
  try {
    const { twitterUsername } = req.params;
    const { name, keywords, description, website, createdAt } = req.body;

    if (!name || !twitterUsername) {
      return res.status(400).json({ error: 'name and twitterUsername required' });
    }

    if (!Array.isArray(keywords) || keywords.some(k => typeof k !== 'string')) {
      return res.status(400).json({ error: 'keywords must be an array of strings' });
    }

    if (website && !/^https?:\/\/[^\s$.?#].[^\s]*$/.test(website)) {
      return res.status(400).json({ error: 'Invalid website URL' });
    }

    if (createdAt && !isValidDate(createdAt)) {
      return res.status(400).json({ error: 'Invalid createdAt date' });
    }

    console.log(`[API] Fetching Twitter user for project: ${twitterUsername}`);
    let twitterUser;
    try {
      twitterUser = await fetchTwitterUser(twitterUsername);
      if (!twitterUser) {
        return res.status(404).json({ error: 'Twitter user not found' });
      }
    } catch (err) {
      if (err.response?.status === 429) {
        const cachedProject = await Project.findOne({ twitterUsername }).lean();
        if (cachedProject) {
          console.log('[API] Using cached project data');
          return res.json({
            message: `Project ${name} retrieved from cache`,
            project: {
              _id: cachedProject._id,
              name: cachedProject.name,
              displayName: cachedProject.displayName,
              createdAt: cachedProject.createdAt,
              description: cachedProject.description || '',
              keywords: cachedProject.keywords || [],
              website: cachedProject.website || '',
              twitterUsername: cachedProject.twitterUsername,
              userId: cachedProject.userId,
              profile_image_url: cachedProject.profile_image_url,
              followers_count: cachedProject.followers_count,
              following_count: cachedProject.following_count,
              updatedAt: cachedProject.updatedAt
            },
            warning: 'Using cached data due to Twitter API rate limit'
          });
        }
        return res.status(503).json({ 
          error: 'Service temporarily unavailable', 
          details: 'Twitter API rate limit exceeded, no cached data available' 
        });
      }
      throw err;
    }

    const projectData = {
      name: name.toUpperCase(),
      displayName: twitterUser.name || '',
      keywords: keywords || [],
      description: description || '',
      website: website || '',
      twitterUsername: twitterUser.username,
      userId: twitterUser.id,
      profile_image_url: twitterUser.profile_image_url || '',
      followers_count: twitterUser.public_metrics?.followers_count || 0,
      following_count: twitterUser.public_metrics?.following_count || 0,
      updatedAt: new Date(),
      createdAt: createdAt ? new Date(createdAt) : new Date()
    };

    const project = await Project.findOneAndUpdate(
      { twitterUsername },
      { $set: projectData, $setOnInsert: { createdAt: createdAt ? new Date(createdAt) : new Date() } },
      { upsert: true, new: true }
    );
    console.log(`[MongoDB] Project ${name} saved/updated:`, project);

    res.json({
      message: `Project ${name} saved/updated`,
      project: {
        _id: project._id,
        name: project.name,
        displayName: project.displayName,
        createdAt: project.createdAt,
        description: project.description,
        keywords: project.keywords,
        website: project.website,
        twitterUsername: project.twitterUsername,
        userId: project.userId,
        profile_image_url: project.profile_image_url,
        followers_count: project.followers_count,
        following_count: project.following_count,
        updatedAt: project.updatedAt
      }
    });
  } catch (err) {
    console.error('[API] POST /projects/:twitterUsername error:', err.response?.status, err.message, err.stack);
    res.status(err.response?.status || 500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/posts/:username', async (req, res) => {
  try {
    const { username } = req.params;

    let userDoc = await User.findOne({ username }).lean();
    if (!userDoc) {
      console.log(`[API] User ${username} not found, fetching and saving Twitter details`);
      let twitterUser;
      try {
        twitterUser = await fetchTwitterUser(username);
        if (!twitterUser) {
          return res.status(404).json({ error: 'Twitter user not found' });
        }
      } catch (err) {
        if (err.response?.status === 429) {
          rateLimitUntil = new Date(Date.now() + 15 * 60 * 1000);
          console.log(`[API] Rate limit hit, pausing until ${rateLimitUntil}`);
          return res.status(503).json({ 
            error: 'Service temporarily unavailable', 
            details: 'Twitter API rate limit exceeded' 
          });
        }
        throw err;
      }

      const userData = {
        userId: twitterUser.id,
        username: twitterUser.username,
        name: twitterUser.name || '',
        profile_image_url: twitterUser.profile_image_url || '',
        followers_count: twitterUser.public_metrics?.followers_count || 0,
        following_count: twitterUser.public_metrics?.following_count || 0,
        updatedAt: new Date()
      };
      userDoc = await User.findOneAndUpdate(
        { username },
        { $set: userData },
        { upsert: true, new: true, lean: true }
      );
      console.log(`[MongoDB] New user ${username} saved with Twitter details:`, userData);
    }

    console.log(`[API] Fetching timeline for user: ${username}`);
    let twitterUser;
    try {
      twitterUser = await fetchTwitterUser(username);
      if (!twitterUser) {
        return res.status(404).json({ error: 'Twitter user not found' });
      }
    } catch (err) {
      if (err.response?.status === 429) {
        rateLimitUntil = new Date(Date.now() + 15 * 60 * 1000);
        console.log(`[API] Rate limit hit, pausing until ${rateLimitUntil}`);
        if (userDoc) {
          console.log('[API] Using cached user data for posts');
          const cachedPosts = await Post.find({
            userId: userDoc.userId,
            createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
            tweetType: { $in: ['main', 'quote', 'replied_to'] }
          }).lean();
          const dbProjects = await Project.find().lean();
          if (!dbProjects.length) {
            return res.status(404).json({ error: 'No projects configured' });
          }
          const categorizedPosts = {};
          dbProjects.forEach(project => {
            categorizedPosts[project.name.toUpperCase()] = [];
          });
          cachedPosts.forEach(post => {
            const postData = {
              SOL_ID: post.SOL_ID || userDoc.userId,
              DEV_ID: post.DEV_ID || '',
              userId: post.userId,
              username: post.username,
              postId: post.postId,
              content: post.content,
              project: post.project,
              score: post.score,
              blabz: post.blabz,
              likes: post.likes,
              retweets: post.retweets,
              replies: post.replies,
              hashtags: post.hashtags || [],
              tweetUrl: post.tweetUrl,
              createdAt: post.createdAt,
              tweetType: post.tweetType,
              updatedAt: post.updatedAt
            };
            post.project.forEach(project => {
              if (categorizedPosts[project]) {
                categorizedPosts[project].push(postData);
              }
            });
          });
          for (const project in categorizedPosts) {
            const seenPostIds = new Set();
            categorizedPosts[project] = categorizedPosts[project].filter(post => {
              if (seenPostIds.has(post.postId)) return false;
              seenPostIds.add(post.postId);
              return true;
            });
            categorizedPosts[project].sort((a, b) => b.score - a.score);
          }
          const totalPosts = Object.values(categorizedPosts).reduce((sum, posts) => sum + posts.length, 0);
          return res.json({
            message: totalPosts ? 'Posts retrieved from cache' : 'No relevant posts found in cache',
            posts: categorizedPosts,
            warning: 'Using cached data due to Twitter API rate limit'
          });
        }
        return res.status(503).json({ 
          error: 'Service temporarily unavailable', 
          details: 'Twitter API rate limit exceeded, no cached data available' 
        });
      }
      throw err;
    }

    const userId = twitterUser.id;
    const followersCount = twitterUser.public_metrics?.followers_count || 0;

    const userData = {
      userId,
      username: twitterUser.username,
      name: twitterUser.name || '',
      profile_image_url: twitterUser.profile_image_url || '',
      followers_count: followersCount,
      updatedAt: new Date()
    };
    await User.findOneAndUpdate(
      { userId },
      { $set: userData },
      { upsert: true }
    );
    console.log(`[MongoDB] User ${username} updated`);

    const dbProjects = await Project.find().lean();
    if (!dbProjects.length) {
      return res.status(404).json({ error: 'No projects configured' });
    }

    console.log('[API] Attempting Twitter API call for user timeline');
    let tweets;
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const tweetsResponse = await axios.get(`https://api.twitter.com/2/users/${userId}/tweets`, {
        headers: {
          Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
          'Content-Type': 'application/json'
        },
        params: {
          'tweet.fields': 'created_at,public_metrics,text,referenced_tweets',
          max_results: 50,
          start_time: sevenDaysAgo
        }
      }).catch(err => {
        if (err.response?.status === 429) {
          rateLimitUntil = new Date(Date.now() + 15 * 60 * 1000);
          console.log(`[API] Rate limit hit, pausing until ${rateLimitUntil}`);
        }
        throw err;
      });
      console.log('[API] Twitter API tweets response:', tweetsResponse.data);
      tweets = tweetsResponse.data.data || [];
    } catch (err) {
      if (err.response?.status === 429) {
        rateLimitUntil = new Date(Date.now() + 15 * 60 * 1000);
        console.log(`[API] Rate limit hit, pausing until ${rateLimitUntil}`);
        const cachedPosts = await Post.find({
          userId: userDoc.userId,
          createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          tweetType: { $in: ['main', 'quote', 'replied_to'] }
        }).lean();
        const categorizedPosts = {};
        dbProjects.forEach(project => {
          categorizedPosts[project.name.toUpperCase()] = [];
        });
        cachedPosts.forEach(post => {
          const postData = {
            SOL_ID: post.SOL_ID || userDoc.userId,
            DEV_ID: post.DEV_ID || '',
            userId: post.userId,
            username: post.username,
            postId: post.postId,
            content: post.content,
            project: post.project,
            score: post.score,
            blabz: post.blabz,
            likes: post.likes,
            retweets: post.retweets,
            replies: post.replies,
            hashtags: post.hashtags || [],
            tweetUrl: post.tweetUrl,
            createdAt: post.createdAt,
            tweetType: post.tweetType,
            updatedAt: post.updatedAt
          };
          post.project.forEach(project => {
            if (categorizedPosts[project]) {
              categorizedPosts[project].push(postData);
            }
          });
        });
        for (const project in categorizedPosts) {
          const seenPostIds = new Set();
          categorizedPosts[project] = categorizedPosts[project].filter(post => {
            if (seenPostIds.has(post.postId)) return false;
            seenPostIds.add(post.postId);
            return true;
          });
          categorizedPosts[project].sort((a, b) => b.score - a.score);
        }
        const totalPosts = Object.values(categorizedPosts).reduce((sum, posts) => sum + posts.length, 0);
        return res.json({
          message: totalPosts ? 'Posts retrieved from cache' : 'No relevant posts found in cache',
          posts: categorizedPosts,
          warning: 'Using cached data due to Twitter API rate limit'
        });
      }
      throw err;
    }

    const categorizedPosts = {};
    dbProjects.forEach(project => {
      categorizedPosts[project.name.toUpperCase()] = [];
    });

    if (tweets.length) {
      for (const tweet of tweets) {
        if (tweet.referenced_tweets?.[0]?.type && !['quoted', 'replied_to'].includes(tweet.referenced_tweets[0].type)) {
          console.log(`[API] Skipping non-post/quote/reply tweet ${tweet.id}`);
          await ProcessedPost.findOneAndUpdate(
            { postId: tweet.id },
            { postId: tweet.id, updatedAt: new Date() },
            { upsert: true }
          );
          continue;
        }

        if (tweet.text.length < 51) {
          console.log(`[API] Skipping short tweet ${tweet.id}`);
          await ProcessedPost.findOneAndUpdate(
            { postId: tweet.id },
            { postId: tweet.id, updatedAt: new Date() },
            { upsert: true }
          );
          continue;
        }

        if (extractMentions(tweet.text) / tweet.text.length > 0.6) {
          console.log(`[API] Skipping mention-heavy tweet ${tweet.id}`);
          await ProcessedPost.findOneAndUpdate(
            { postId: tweet.id },
            { postId: tweet.id, updatedAt: new Date() },
            { upsert: true }
          );
          continue;
        }

        if (await ProcessedPost.findOne({ postId: tweet.id }).lean()) {
          console.log(`[API] Skipping already processed tweet ${tweet.id}`);
          continue;
        }

        const text = tweet.text.toLowerCase();
        const matchedProjects = dbProjects
          .filter(project => {
            const terms = [project.name.toLowerCase(), ...project.keywords.map(k => k.toLowerCase())];
            return terms.some(term => text.includes(term));
          })
          .map(project => project.name.toUpperCase());

        if (matchedProjects.length === 0) {
          console.log(`[API] Skipping tweet ${tweet.id} with no project match`);
          await ProcessedPost.findOneAndUpdate(
            { postId: tweet.id },
            { postId: tweet.id, updatedAt: new Date() },
            { upsert: true }
          );
          continue;
        }

        const qualityScore = calculateQualityScore(tweet, followersCount);
        const projectBlabz = parseFloat(calculateBlabzPerProject(qualityScore));
        const totalBlabz = (projectBlabz * matchedProjects.length).toFixed(4);

        const postData = {
          SOL_ID: userDoc.SOL_ID || userId,
          DEV_ID: userDoc.DEV_ID || '',
          userId,
          username,
          postId: tweet.id,
          content: tweet.text,
          project: matchedProjects,
          score: qualityScore,
          blabz: totalBlabz,
          likes: tweet.public_metrics?.like_count || 0,
          retweets: tweet.public_metrics?.retweet_count || 0,
          replies: tweet.public_metrics?.reply_count || 0,
          hashtags: extractHashtags(tweet.text),
          tweetUrl: `https://x.com/${username}/status/${tweet.id}`,
          createdAt: new Date(tweet.created_at),
          tweetType: tweet.referenced_tweets?.[0]?.type || 'main',
          updatedAt: new Date()
        };

        const post = await Post.findOneAndUpdate(
          { postId: tweet.id },
          { $set: postData },
          { upsert: true, new: true }
        );
        await ProcessedPost.findOneAndUpdate(
          { postId: tweet.id },
          { postId: tweet.id, updatedAt: new Date() },
          { upsert: true }
        );
        console.log(`[MongoDB] Post ${tweet.id} saved for user ${username}`);

        matchedProjects.forEach(project => {
          if (categorizedPosts[project]) {
            categorizedPosts[project].push(postData);
          }
        });
      }
    }

    const dbPosts = await Post.find({
      userId,
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      tweetType: { $in: ['main', 'quote', 'replied_to'] }
    }).lean();
    dbPosts.forEach(post => {
      const postData = {
        SOL_ID: post.SOL_ID || userId,
        DEV_ID: post.DEV_ID || '',
        userId: post.userId,
        username: post.username,
        postId: post.postId,
        content: post.content,
        project: post.project,
        score: post.score,
        blabz: post.blabz,
        likes: post.likes,
        retweets: post.retweets,
        replies: post.replies,
        hashtags: post.hashtags || [],
        tweetUrl: post.tweetUrl,
        createdAt: post.createdAt,
        tweetType: post.tweetType,
        updatedAt: post.updatedAt
      };
      post.project.forEach(project => {
        if (categorizedPosts[project]) {
          categorizedPosts[project].push(postData);
        }
      });
    });

    for (const project in categorizedPosts) {
      const seenPostIds = new Set();
      categorizedPosts[project] = categorizedPosts[project].filter(post => {
        if (seenPostIds.has(post.postId)) return false;
        seenPostIds.add(post.postId);
        return true;
      });
      categorizedPosts[project].sort((a, b) => b.score - a.score);
    }

    const totalPosts = Object.values(categorizedPosts).reduce((sum, posts) => sum + posts.length, 0);
    res.json({
      message: totalPosts ? 'Posts retrieved' : 'No relevant posts found',
      posts: categorizedPosts
    });
  } catch (err) {
firestore.collection('users').doc(user.uid).set({
        SOL_ID: solId,
        DEV_ID: devId,
        userId: twitterUser.id,
        username: twitterUser.username,
        name: twitterUser.name || '',
        profile_image_url: twitterUser.profile_image_url || '',
        followers_count: twitterUser.public_metrics?.followers_count || 0,
        following_count: twitterUser.public_metrics?.following_count || 0,
        updatedAt: new Date()
      }, { merge: true });
      console.log(`[Firestore] User ${username} saved`);
      res.json({ message: `User ${username} saved`, user: {
        SOL_ID: solId,
        DEV_ID: devId,
        userId: twitterUser.id,
        username: twitterUser.username,
        name: twitterUser.name,
        profile_image_url: twitterUser.profile_image_url,
        followers_count: twitterUser.public_metrics.followers_count,
        following_count: twitterUser.public_metrics.following_count
      }});
    } catch (err) {
      console.error('[API] POST /users error:', err.response?.status, err.message, err.stack);
      res.status(err.response?.status || 500).json({ error: 'Server error', details: err.message });
    }
  });
  
  router.get('/user-details/:username', async (req, res) => {
    try {
      console.log(`[API] Fetching user: ${req.params.username}`);
      const cachedUser = await firestore.collection('users').where('username', '==', req.params.username).get();
      let userDoc;
      if (!cachedUser.empty && cachedUser.docs[0].data().updatedAt.toDate() > new Date(Date.now() - 15 * 60 * 1000)) {
        userDoc = cachedUser.docs[0].data();
        console.log('[API] Using fresh cached user data');
        return res.json({
          SOL_ID: userDoc.SOL_ID || '',
          DEV_ID: userDoc.DEV_ID || '',
          userId: userDoc.userId,
          username: userDoc.username,
          name: userDoc.name,
          profile_image_url: userDoc.profile_image_url,
          followers_count: userDoc.followers_count,
          following_count: userDoc.following_count
        });
      }
  
      let twitterUser;
      try {
        twitterUser = await fetchTwitterUser(req.params.username);
        if (!twitterUser) {
          return res.status(404).json({ error: 'User not found' });
        }
      } catch (err) {
        if (err.response?.status === 429) {
          if (!cachedUser.empty) {
            userDoc = cachedUser.docs[0].data();
            console.log('[API] Using cached user data');
            return res.json({
              SOL_ID: userDoc.SOL_ID || '',
              DEV_ID: userDoc.DEV_ID || '',
              userId: userDoc.userId,
              username: userDoc.username,
              name: userDoc.name,
              profile_image_url: userDoc.profile_image_url,
              followers_count: userDoc.followers_count,
              following_count: userDoc.following_count,
              warning: 'Using cached data due to Twitter API rate limit'
            });
          }
          return res.status(503).json({ 
            error: 'Service temporarily unavailable', 
            details: 'Twitter API rate limit exceeded, no cached data available' 
          });
        }
        throw err;
      }
  
      const userData = {
        userId: twitterUser.id,
        username: twitterUser.username,
        name: twitterUser.name || '',
        profile_image_url: twitterUser.profile_image_url || '',
        followers_count: twitterUser.public_metrics?.followers_count || 0,
        following_count: twitterUser.public_metrics?.following_count || 0,
        updatedAt: new Date()
      };
      await firestore.collection('users').doc(twitterUser.id).set(userData, { merge: true });
      console.log('[API] Firestore userDoc updated:', userData);
  
      res.json({
        SOL_ID: userData.SOL_ID || '',
        DEV_ID: userData.DEV_ID || '',
        userId: twitterUser.id,
        username: twitterUser.username,
        name: twitterUser.name,
        profile_image_url: twitterUser.profile_image_url,
        followers_count: twitterUser.public_metrics.followers_count,
        following_count: twitterUser.public_metrics.following_count
      });
    } catch (err) {
      console.error('[API] GET /user-details error:', err.response?.status, err.message, err.stack);
      res.status(err.response?.status || 500).json({ error: 'Server error', details: err.message });
    }
  });
  
  router.get('/rate-limit-status', async (req, res) => {
    try {
      console.log('[API] Checking Twitter API rate limit status');
      if (rateLimitUntil && rateLimitUntil > new Date()) {
        return res.json({ 
          message: 'Rate limit active', 
          rateLimit: {
            remaining: 0,
            reset: rateLimitUntil
          }
        });
      }
  
      let response;
      try {
        response = await axios.get('https://api.twitter.com/2/users/by', {
          headers: {
            Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
            'Content-Type': 'application/json'
          },
          params: {
            usernames: 'test',
            'user.fields': 'id'
          }
        });
      } catch (err) {
        if (err.response?.status === 429) {
          rateLimitUntil = new Date(Date.now() + 15 * 60 * 1000);
          console.log(`[API] Rate limit hit, pausing until ${rateLimitUntil}`);
          return res.json({ 
            message: 'Rate limit active', 
            rateLimit: {
              remaining: 0,
              reset: rateLimitUntil
            }
          });
        }
        throw err;
      }
  
      console.log('[API] Rate limit check response:', response.headers);
      res.json({ 
        message: 'Rate limit check', 
        rateLimit: {
          limit: response.headers['x-rate-limit-limit'],
          remaining: response.headers['x-rate-limit-remaining'],
          reset: new Date(parseInt(response.headers['x-rate-limit-reset']) * 1000)
        }
      });
    } catch (err) {
      console.error('[API] Rate limit check error:', err.response?.status, err.message, err.stack);
      res.status(err.response?.status || 500).json({ 
        error: 'Rate limit check failed', 
        details: err.message 
      });
    }
  });
  
  router.post('/projects', async (req, res) => {
    try {
      const { name, keywords, description, twitterUsername, userId, profile_image_url, displayName, followers_count, following_count } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'Name required' });
      }
      const projectData = {
        name: name.toUpperCase(),
        displayName: displayName || '',
        keywords: keywords || [],
        description: description || '',
        twitterUsername: twitterUsername || '',
        userId: userId || '',
        profile_image_url: profile_image_url || '',
        followers_count: followers_count || 0,
        following_count: following_count || 0,
        updatedAt: new Date()
      };
      await firestore.collection('projects').doc(name.toUpperCase()).set(projectData, { merge: true });
      console.log(`[Firestore] Project ${name} saved:`, projectData);
      res.json({ message: `Project ${name} added`, project: projectData });
    } catch (err) {
      console.error('[API] POST /projects error:', err.message, err.stack);
      res.status(400).json({ error: 'Server error', details: err.message });
    }
  });
  
  router.put('/project/:project', async (req, res) => {
    try {
      const { keywords, description, twitterUsername, userId, profile_image_url, displayName, followers_count, following_count } = req.body;
      const projectData = {
        name: req.params.project.toUpperCase(),
        displayName: displayName || '',
        keywords: keywords || [],
        description: description || '',
        twitterUsername: twitterUsername || '',
        userId: userId || '',
        profile_image_url: profile_image_url || '',
        followers_count: followers_count || 0,
        following_count: following_count || 0,
        updatedAt: new Date()
      };
      const projectRef = await firestore.collection('projects').doc(req.params.project.toUpperCase()).get();
      if (!projectRef.exists) {
        return res.status(404).json({ error: 'Project not found' });
      }
      await firestore.collection('projects').doc(req.params.project.toUpperCase()).set(projectData, { merge: true });
      console.log(`[Firestore] Project ${req.params.project} updated:`, projectData);
      res.json({ message: `Project ${req.params.project} updated`, project: projectData });
    } catch (err) {
      console.error('[API] PUT /project error:', err.message, err.stack);
      res.status(500).json({ error: 'Server error', details: err.message });
    }
  });
  
  router.post('/projects/:twitterUsername', async (req, res) => {
    try {
      const { twitterUsername } = req.params;
      const { name, keywords, description, website, createdAt } = req.body;
  
      if (!name || !twitterUsername) {
        return res.status(400).json({ error: 'name and twitterUsername required' });
      }
  
      if (!Array.isArray(keywords) || keywords.some(k => typeof k !== 'string')) {
        return res.status(400).json({ error: 'keywords must be an array of strings' });
      }
  
      if (website && !/^https?:\/\/[^\s$.?#].[^\s]*$/.test(website)) {
        return res.status(400).json({ error: 'Invalid website URL' });
      }
  
      if (createdAt && !isValidDate(createdAt)) {
        return res.status(400).json({ error: 'Invalid createdAt date' });
      }
  
      console.log(`[API] Fetching Twitter user for project: ${twitterUsername}`);
      let twitterUser;
      try {
        twitterUser = await fetchTwitterUser(twitterUsername);
        if (!twitterUser) {
          return res.status(404).json({ error: 'Twitter user not found' });
        }
      } catch (err) {
        if (err.response?.status === 429) {
          const cachedProject = await firestore.collection('projects').where('twitterUsername', '==', twitterUsername).get();
          if (!cachedProject.empty) {
            const projectData = cachedProject.docs[0].data();
            console.log('[API] Using cached project data');
            return res.json({
              message: `Project ${name} retrieved from cache`,
              project: {
                _id: cachedProject.docs[0].id,
                name: projectData.name,
                displayName: projectData.displayName,
                createdAt: projectData.createdAt ? projectData.createdAt.toDate() : null,
                description: projectData.description || '',
                keywords: projectData.keywords || [],
                website: projectData.website || '',
                twitterUsername: projectData.twitterUsername,
                userId: projectData.userId,
                profile_image_url: projectData.profile_image_url,
                followers_count: projectData.followers_count,
                following_count: projectData.following_count,
                updatedAt: projectData.updatedAt ? projectData.updatedAt.toDate() : null
              },
              warning: 'Using cached data due to Twitter API rate limit'
            });
          }
          return res.status(503).json({ 
            error: 'Service temporarily unavailable', 
            details: 'Twitter API rate limit exceeded, no cached data available' 
          });
        }
        throw err;
      }
  
      const projectData = {
        name: name.toUpperCase(),
        displayName: twitterUser.name || '',
        keywords: keywords || [],
        description: description || '',
        website: website || '',
        twitterUsername: twitterUser.username,
        userId: twitterUser.id,
        profile_image_url: twitterUser.profile_image_url || '',
        followers_count: twitterUser.public_metrics?.followers_count || 0,
        following_count: twitterUser.public_metrics?.following_count || 0,
        updatedAt: new Date(),
        createdAt: createdAt ? new Date(createdAt) : new Date()
      };
  
      await firestore.collection('projects').doc(twitterUser.username).set(projectData, { merge: true });
      console.log(`[Firestore] Project ${name} saved/updated:`, projectData);
  
      res.json({
        message: `Project ${name} saved/updated`,
        project: {
          _id: twitterUser.username,
          name: projectData.name,
          displayName: projectData.displayName,
          createdAt: projectData.createdAt,
          description: projectData.description,
          keywords: projectData.keywords,
          website: projectData.website,
          twitterUsername: projectData.twitterUsername,
          userId: projectData.userId,
          profile_image_url: projectData.profile_image_url,
          followers_count: projectData.followers_count,
          following_count: projectData.following_count,
          updatedAt: projectData.updatedAt
        }
      });
    } catch (err) {
      console.error('[API] POST /projects/:twitterUsername error:', err.response?.status, err.message, err.stack);
      res.status(err.response?.status || 500).json({ error: 'Server error', details: err.message });
    }
  });
  
  router.get('/posts/:username', async (req, res) => {
    try {
      const { username } = req.params;
  
      let userDoc = await firestore.collection('users').where('username', '==', username).get();
      if (userDoc.empty) {
        console.log(`[API] User ${username} not found, fetching and saving Twitter details`);
        let twitterUser;
        try {
          twitterUser = await fetchTwitterUser(username);
          if (!twitterUser) {
            return res.status(404).json({ error: 'Twitter user not found' });
          }
        } catch (err) {
          if (err.response?.status === 429) {
            rateLimitUntil = new Date(Date.now() + 15 * 60 * 1000);
            console.log(`[API] Rate limit hit, pausing until ${rateLimitUntil}`);
            return res.status(503).json({ 
              error: 'Service temporarily unavailable', 
              details: 'Twitter API rate limit exceeded' 
            });
          }
          throw err;
        }
  
        const userData = {
          userId: twitterUser.id,
          username: twitterUser.username,
          name: twitterUser.name || '',
          profile_image_url: twitterUser.profile_image_url || '',
          followers_count: twitterUser.public_metrics?.followers_count || 0,
          following_count: twitterUser.public_metrics?.following_count || 0,
          updatedAt: new Date()
        };
        await firestore.collection('users').doc(twitterUser.id).set(userData, { merge: true });
        userDoc = { docs: [{ data: () => userData }] };
        console.log(`[Firestore] New user ${username} saved with Twitter details:`, userData);
      } else {
        userDoc = userDoc.docs[0].data();
      }
  
      console.log(`[API] Fetching timeline for user: ${username}`);
      let twitterUser;
      try {
        twitterUser = await fetchTwitterUser(username);
        if (!twitterUser) {
          return res.status(404).json({ error: 'Twitter user not found' });
        }
      } catch (err) {
        if (err.response?.status === 429) {
          rateLimitUntil = new Date(Date.now() + 15 * 60 * 1000);
          console.log(`[API] Rate limit hit, pausing until ${rateLimitUntil}`);
          if (userDoc) {
            console.log('[API] Using cached user data for posts');
            const cachedPosts = await firestore.collection('posts')
              .where('userId', '==', userDoc.userId)
              .where('createdAt', '>=', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
              .where('tweetType', 'in', ['main', 'quote', 'replied_to'])
              .get();
            const dbProjects = await firestore.collection('projects').get();
            if (dbProjects.empty) {
              return res.status(404).json({ error: 'No projects configured' });
            }
            const categorizedPosts = {};
            dbProjects.forEach(doc => {
              categorizedPosts[doc.data().name.toUpperCase()] = [];
            });
            cachedPosts.forEach(doc => {
              const post = doc.data();
              const postData = {
                SOL_ID: post.SOL_ID || userDoc.userId,
                DEV_ID: post.DEV_ID || '',
                userId: post.userId,
                username: post.username,
                postId: post.postId,
                content: post.content,
                project: post.project,
                score: post.score,
                blabz: post.blabz,
                likes: post.likes,
                retweets: post.retweets,
                replies: post.replies,
                hashtags: post.hashtags || [],
                tweetUrl: post.tweetUrl,
                createdAt: post.createdAt.toDate(),
                tweetType: post.tweetType,
                updatedAt: post.updatedAt.toDate()
              };
              post.project.forEach(project => {
                if (categorizedPosts[project]) {
                  categorizedPosts[project].push(postData);
                }
              });
            });
            for (const project in categorizedPosts) {
              const seenPostIds = new Set();
              categorizedPosts[project] = categorizedPosts[project].filter(post => {
                if (seenPostIds.has(post.postId)) return false;
                seenPostIds.add(post.postId);
                return true;
              });
              categorizedPosts[project].sort((a, b) => b.score - a.score);
            }
            const totalPosts = Object.values(categorizedPosts).reduce((sum, posts) => sum + posts.length, 0);
            return res.json({
              message: totalPosts ? 'Posts retrieved from cache' : 'No relevant posts found in cache',
              posts: categorizedPosts,
              warning: 'Using cached data due to Twitter API rate limit'
            });
          }
          return res.status(503).json({ 
            error: 'Service temporarily unavailable', 
            details: 'Twitter API rate limit exceeded, no cached data available' 
          });
        }
        throw err;
      }
  
      const userId = twitterUser.id;
      const followersCount = twitterUser.public_metrics?.followers_count || 0;
  
      const userData = {
        userId,
        username: twitterUser.username,
        name: twitterUser.name || '',
        profile_image_url: twitterUser.profile_image_url || '',
        followers_count: followersCount,
        updatedAt: new Date()
      };
      await firestore.collection('users').doc(userId).set(userData, { merge: true });
      console.log(`[Firestore] User ${username} updated`);
  
      const dbProjects = await firestore.collection('projects').get();
      if (dbProjects.empty) {
        return res.status(404).json({ error: 'No projects configured' });
      }
  
      console.log('[API] Attempting Twitter API call for user timeline');
      let tweets;
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const tweetsResponse = await axios.get(`https://api.twitter.com/2/users/${userId}/tweets`, {
          headers: {
            Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
            'Content-Type': 'application/json'
          },
          params: {
            'tweet.fields': 'created_at,public_metrics,text,referenced_tweets',
            max_results: 50,
            start_time: sevenDaysAgo
          }
        }).catch(err => {
          if (err.response?.status === 429) {
            rateLimitUntil = new Date(Date.now() + 15 * 60 * 1000);
            console.log(`[API] Rate limit hit, pausing until ${rateLimitUntil}`);
          }
          throw err;
        });
        console.log('[API] Twitter API tweets response:', tweetsResponse.data);
        tweets = tweetsResponse.data.data || [];
      } catch (err) {
        if (err.response?.status === 429) {
          rateLimitUntil = new Date(Date.now() + 15 * 60 * 1000);
          console.log(`[API] Rate limit hit, pausing until ${rateLimitUntil}`);
          const cachedPosts = await firestore.collection('posts')
            .where('userId', '==', userDoc.userId)
            .where('createdAt', '>=', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
            .where('tweetType', 'in', ['main', 'quote', 'replied_to'])
            .get();
          const categorizedPosts = {};
          dbProjects.forEach(doc => {
            categorizedPosts[doc.data().name.toUpperCase()] = [];
          });
          cachedPosts.forEach(doc => {
            const post = doc.data();
            const postData = {
              SOL_ID: post.SOL_ID || userDoc.userId,
              DEV_ID: post.DEV_ID || '',
              userId: post.userId,
              username: post.username,
              postId: post.postId,
              content: post.content,
              project: post.project,
              score: post.score,
              blabz: post.blabz,
              likes: post.likes,
              retweets: post.retweets,
              replies: post.replies,
              hashtags: post.hashtags || [],
              tweetUrl: post.tweetUrl,
              createdAt: post.createdAt.toDate(),
              tweetType: post.tweetType,
              updatedAt: post.updatedAt.toDate()
            };
            post.project.forEach(project => {
              if (categorizedPosts[project]) {
                categorizedPosts[project].push(postData);
              }
            });
          });
          for (const project in categorizedPosts) {
            const seenPostIds = new Set();
            categorizedPosts[project] = categorizedPosts[project].filter(post => {
              if (seenPostIds.has(post.postId)) return false;
              seenPostIds.add(post.postId);
              return true;
            });
            categorizedPosts[project].sort((a, b) => b.score - a.score);
          }
          const totalPosts = Object.values(categorizedPosts).reduce((sum, posts) => sum + posts.length, 0);
          return res.json({
            message: totalPosts ? 'Posts retrieved from cache' : 'No relevant posts found in cache',
            posts: categorizedPosts,
            warning: 'Using cached data due to Twitter API rate limit'
          });
        }
        throw err;
      }
  
      const categorizedPosts = {};
      dbProjects.forEach(doc => {
        categorizedPosts[doc.data().name.toUpperCase()] = [];
      });
  
      if (tweets.length) {
        for (const tweet of tweets) {
          if (tweet.referenced_tweets?.[0]?.type && !['quoted', 'replied_to'].includes(tweet.referenced_tweets[0].type)) {
            console.log(`[API] Skipping non-post/quote/reply tweet ${tweet.id}`);
            await firestore.collection('processedPosts').doc(tweet.id).set({
              postId: tweet.id,
              updatedAt: new Date()
            }, { merge: true });
            continue;
          }
  
          if (tweet.text.length < 51) {
            console.log(`[API] Skipping short tweet ${tweet.id}`);
            await firestore.collection('processedPosts').doc(tweet.id).set({
              postId: tweet.id,
              updatedAt: new Date()
            }, { merge: true });
            continue;
          }
  
          if (extractMentions(tweet.text) / tweet.text.length > 0.6) {
            console.log(`[API] Skipping mention-heavy tweet ${tweet.id}`);
            await firestore.collection('processedPosts').doc(tweet.id).set({
              postId: tweet.id,
              updatedAt: new Date()
            }, { merge: true });
            continue;
          }
  
          const processedPost = await firestore.collection('processedPosts').doc(tweet.id).get();
          if (processedPost.exists) {
            console.log(`[API] Skipping already processed tweet ${tweet.id}`);
            continue;
          }
  
          const text = tweet.text.toLowerCase();
          const matchedProjects = dbProjects.docs
            .filter(doc => {
              const project = doc.data();
              const terms = [project.name.toLowerCase(), ...project.keywords.map(k => k.toLowerCase())];
              return terms.some(term => text.includes(term));
            })
            .map(doc => doc.data().name.toUpperCase());
  
          if (matchedProjects.length === 0) {
            console.log(`[API] Skipping tweet ${tweet.id} with no project match`);
            await firestore.collection('processedPosts').doc(tweet.id).set({
              postId: tweet.id,
              updatedAt: new Date()
            }, { merge: true });
            continue;
          }
  
          const qualityScore = calculateQualityScore(tweet, followersCount);
          const projectBlabz = parseFloat(calculateBlabzPerProject(qualityScore));
          const totalBlabz = (projectBlabz * matchedProjects.length).toFixed(4);
  
          const postData = {
            SOL_ID: userDoc.SOL_ID || userId,
            DEV_ID: userDoc.DEV_ID || '',
            userId,
            username,
            postId: tweet.id,
            content: tweet.text,
            project: matchedProjects,
            score: qualityScore,
            blabz: totalBlabz,
            likes: tweet.public_metrics?.like_count || 0,
            retweets: tweet.public_metrics?.retweet_count || 0,
            replies: tweet.public_metrics?.reply_count || 0,
            hashtags: extractHashtags(tweet.text),
            tweetUrl: `https://x.com/${username}/status/${tweet.id}`,
            createdAt: new Date(tweet.created_at),
            tweetType: tweet.referenced_tweets?.[0]?.type || 'main',
            updatedAt: new Date()
          };
  
          await firestore.collection('posts').doc(tweet.id).set(postData, { merge: true });
          await firestore.collection('processedPosts').doc(tweet.id).set({
            postId: tweet.id,
            updatedAt: new Date()
          }, { merge: true });
          console.log(`[Firestore] Post ${tweet.id} saved for user ${username}`);
  
          matchedProjects.forEach(project => {
            if (categorizedPosts[project]) {
              categorizedPosts[project].push(postData);
            }
          });
        }
      }
  
      const dbPosts = await firestore.collection('posts')
        .where('userId', '==', userId)
        .where('createdAt', '>=', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
        .where('tweetType', 'in', ['main', 'quote', 'replied_to'])
        .get();
      dbPosts.forEach(doc => {
        const post = doc.data();
        const postData = {
          SOL_ID: post.SOL_ID || userId,
          DEV_ID: post.DEV_ID || '',
          userId: post.userId,
          username: post.username,
          postId: post.postId,
          content: post.content,
          project: post.project,
          score: post.score,
          blabz: post.blabz,
          likes: post.likes,
          retweets: post.retweets,
          replies: post.replies,
          hashtags: post.hashtags || [],
          tweetUrl: post.tweetUrl,
          createdAt: post.createdAt.toDate(),
          tweetType: post.tweetType,
          updatedAt: post.updatedAt.toDate()
        };
        post.project.forEach(project => {
          if (categorizedPosts[project]) {
            categorizedPosts[project].push(postData);
          }
        });
      });
  
      for (const project in categorizedPosts) {
        const seenPostIds = new Set();
        categorizedPosts[project] = categorizedPosts[project].filter(post => {
          if (seenPostIds.has(post.postId)) return false;
          seenPostIds.add(post.postId);
          return true;
        });
        categorizedPosts[project].sort((a, b) => b.score - a.score);
      }
  
      const totalPosts = Object.values(categorizedPosts).reduce((sum, posts) => sum + posts.length, 0);
      res.json({
        message: totalPosts ? 'Posts retrieved' : 'No relevant posts found',
        posts: categorizedPosts
      });
    } catch (err) {
      console.error('[API] GET /posts error:', err.response?.status, err.message, err.stack);
      res.status(err.response?.status || 500).json({ error: 'Server error', details: err.message });
    }
  });
  
  router.get('/project-details/:project', async (req, res) => {
    try {
      const { project } = req.params;
      console.log(`[API] Fetching project details for twitterUsername: ${project}`);
  
      let dbProject = await firestore.collection('projects').where('twitterUsername', '==', project).get();
      let projectData;
      if (dbProject.empty) {
        console.log(`[API] Project with twitterUsername ${project} not found, creating new project`);
        projectData = {
          name: project.toUpperCase(),
          displayName: '',
          keywords: [],
          description: '',
          website: '',
          twitterUsername: project,
          userId: '',
          profile_image_url: '',
          followers_count: 0,
          following_count: 0,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        await firestore.collection('projects').doc(project).set(projectData, { merge: true });
        console.log(`[Firestore] Project with twitterUsername ${project} created:`, projectData);
      } else {
        projectData = dbProject.docs[0].data();
      }
  
      if (!projectData.twitterUsername) {
        return res.status(400).json({ error: 'No Twitter username associated with this project' });
      }
  
      if (projectData.userId && projectData.updatedAt > new Date(Date.now() - 15 * 60 * 1000)) {
        console.log(`[API] Using fresh cached project data for ${projectData.twitterUsername}`);
        return res.json({
          _id: dbProject.empty ? project : dbProject.docs[0].id,
          name: projectData.name,
          displayName: projectData.displayName,
          createdAt: projectData.createdAt ? projectData.createdAt.toDate() : null,
          description: projectData.description || '',
          keywords: projectData.keywords || [],
          website: projectData.website || '',
          twitterUsername: projectData.twitterUsername,
          userId: projectData.userId,
          profile_image_url: projectData.profile_image_url,
          followers_count: projectData.followers_count,
          following_count: projectData.following_count,
          updatedAt: projectData.updatedAt ? projectData.updatedAt.toDate() : null
        });
      }
  
      let twitterUser;
      try {
        twitterUser = await fetchTwitterUser(projectData.twitterUsername);
        if (!twitterUser) {
          return res.status(404).json({ error: 'Twitter user not found for project' });
        }
      } catch (err) {
        if (err.response?.status === 429) {
          rateLimitUntil = new Date(Date.now() + 15 * 60 * 1000);
          console.log(`[API] Rate limit hit, pausing until ${rateLimitUntil}`);
          if (projectData.userId) {
            console.log('[API] Using cached project data');
            return res.json({
              _id: dbProject.empty ? project : dbProject.docs[0].id,
              name: projectData.name,
              displayName: projectData.displayName,
              createdAt: projectData.createdAt ? projectData.createdAt.toDate() : null,
              description: projectData.description || '',
              keywords: projectData.keywords || [],
              website: projectData.website || '',
              twitterUsername: projectData.twitterUsername,
              userId: projectData.userId,
              profile_image_url: projectData.profile_image_url,
              followers_count: projectData.followers_count,
              following_count: projectData.following_count,
              updatedAt: projectData.updatedAt ? projectData.updatedAt.toDate() : null,
              warning: 'Using cached data due to Twitter API rate limit'
            });
          }
          return res.status(503).json({ 
            error: 'Service temporarily unavailable', 
            details: 'Twitter API rate limit exceeded, no cached data available' 
          });
        }
        throw err;
      }
  
      projectData = {
        name: projectData.name || project.toUpperCase(),
        displayName: twitterUser.name || '',
        keywords: projectData.keywords || [],
        description: projectData.description || '',
        website: projectData.website || '',
        twitterUsername: twitterUser.username,
        userId: twitterUser.id,
        profile_image_url: twitterUser.profile_image_url || '',
        followers_count: twitterUser.public_metrics?.followers_count || 0,
        following_count: twitterUser.public_metrics?.following_count || 0,
        updatedAt: new Date(),
        createdAt: projectData.createdAt || new Date()
      };
      await firestore.collection('projects').doc(project).set(projectData, { merge: true });
      console.log(`[Firestore] Project with twitterUsername ${project} updated with Twitter details`);
  
      res.json({
        _id: project,
        name: projectData.name,
        displayName: projectData.displayName,
        createdAt: projectData.createdAt,
        description: projectData.description,
        keywords: projectData.keywords,
        website: projectData.website,
        twitterUsername: projectData.twitterUsername,
        userId: twitterUser.id,
        profile_image_url: twitterUser.profile_image_url,
        followers_count: twitterUser.public_metrics.followers_count,
        following_count: twitterUser.public_metrics.following_count,
        updatedAt: projectData.updatedAt
      });
    } catch (err) {
      console.error('[API] GET /project-details error:', err.response?.status, err.message, err.stack);
      res.status(err.response?.status || 500).json({ error: 'Server error', details: err.message });
    }
  });
  
  router.delete('/processed-posts', async (req, res) => {
    try {
      console.log('[API] Clearing all processed posts');
      const processedPosts = await firestore.collection('processedPosts').get();
      const batch = firestore.batch();
      processedPosts.forEach(doc => {
        batch.delete(doc.ref);
      });
      await batch.commit();
      console.log(`[Firestore] Deleted ${processedPosts.size} processed posts`);
      res.json({
        message: `Successfully deleted ${processedPosts.size} processed posts`,
        deletedCount: processedPosts.size
      });
    } catch (err) {
      console.error('[API] DELETE /processed-posts error:', err.message, err.stack);
      res.status(500).json({ error: 'Server error', details: err.message });
    }
  });
  
  module.exports = router;
