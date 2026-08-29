const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { nanoid } = require('nanoid');

const RECEIPTS_DIR = path.join(__dirname, '..', '..', 'uploads', 'receipts');
const MENU_ICONS_DIR = path.join(__dirname, '..', '..', 'uploads', 'menu-icons');
fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
fs.mkdirSync(MENU_ICONS_DIR, { recursive: true });

const imageFileFilter = (req, file, cb) => {
  const ok = /^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype);
  cb(ok ? null : new Error('Only image uploads are allowed'), ok);
};

function diskStorageFor(dir) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}-${nanoid(8)}${ext}`);
    },
  });
}

const uploadReceipt = multer({
  storage: diskStorageFor(RECEIPTS_DIR),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

const uploadMenuIcon = multer({
  storage: diskStorageFor(MENU_ICONS_DIR),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

module.exports = { uploadReceipt, uploadMenuIcon, RECEIPTS_DIR, MENU_ICONS_DIR };
