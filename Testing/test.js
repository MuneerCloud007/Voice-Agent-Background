import ffmpeg from 'fluent-ffmpeg';

const voicePath       = 'Sample1.wav';        // actual voice file in current dir
const backgroundPath  = 'Sample2.wav';   // background noise file in current dir
const outputFilename  = 'mixed_output.wav'; // will be created in current dir
const outputPath      = `./${outputFilename}`; // ensure “./” to indicate current dir

ffmpeg()
  .input(voicePath)
  .input(backgroundPath)
  .complexFilter([
    {
      filter : 'volume',
      options: { volume: 1.0 },
      inputs : '0:a',
      outputs: 'a0'
    },
    {
      filter : 'volume',
      options: { volume: 0.3 },
      inputs : '1:a',
      outputs: 'a1'
    },
    {
      filter : 'amix',
      options: { inputs: 2, duration: 'shortest', dropout_transition: 2 },
      inputs : ['a0','a1'],
      outputs: 'mixout'
    }
  ])
  .outputOptions([
    '-map [mixout]',
    '-c:a pcm_s16le'
  ])
  .save(outputPath)
  .on('start', commandLine => {
    console.log('FFmpeg command:', commandLine);
  })
  .on('progress', progress => {
    console.log(`Processing: ${progress.percent ? progress.percent.toFixed(2) : ''}% done`);
  })
  .on('error', (err, stdout, stderr) => {
    console.error('Error during processing:', err.message);
    console.error('FFmpeg stderr:', stderr);
  })
  .on('end', () => {
    console.log(`Mixing finished successfully — output file: ${outputPath}`);
  });


 