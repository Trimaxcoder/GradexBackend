const mongoose = require('mongoose');

const CourseSchema = new mongoose.Schema(
  {
    // owner reference
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true,
    },

    // mirrors Flutter Course model exactly
    clientId: {
      type:  String,
      default: '',            // stores the Flutter-generated id for sync
    },
    name: {
      type:     String,
      required: [true, 'Course code/name is required'],
      trim:     true,
      uppercase: true,
    },
    title: {
      type:  String,
      default: '',
      trim:  true,
    },
    score: {
      type:    Number,
      required: true,
      min:     [0,   'Score cannot be negative'],
      max:     [100, 'Score cannot exceed 100'],
    },
    unit: {
      type:    Number,
      required: true,
      min:     [1, 'Unit must be at least 1'],
      max:     [6, 'Unit cannot exceed 6'],
    },
    year: {
      type:    Number,
      required: true,
      min:     [1, 'Year must be at least 1'],
      max:     [7, 'Year cannot exceed 7'],
    },
    semester: {
      type:    Number,
      required: true,
      enum:    [1, 2],
    },
  },
  { timestamps: true }
);

// Compound index — prevents exact duplicates per user
CourseSchema.index({ userId: 1, name: 1, unit: 1, year: 1, semester: 1 }, { unique: true });

module.exports = mongoose.model('Course', CourseSchema);
