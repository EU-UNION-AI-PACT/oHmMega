# oHmMega

A versatile command-line interface tool for processing and managing data.

## Installation

Clone this repository and make the CLI executable:

```bash
git clone https://github.com/EU-UNION-AI-PACT/oHmMega.git
cd oHmMega
chmod +x ohmega
```

## Usage

### Basic Commands

```bash
# Display help
./ohmega --help

# Show version
./ohmega --version

# Get information about oHmMega
./ohmega info

# Get information in JSON format
./ohmega info --format json
```

### Processing Data

```bash
# Process simple data
./ohmega process "your data here"

# Process with verbose output
./ohmega -v process "your data here"

# Process and save to file
./ohmega process "your data here" -o output.txt

# Process with verbose mode and output file
./ohmega -v process "your data here" -o result.txt
```

### Available Commands

- `info` - Display information about oHmMega
  - `--format` - Choose output format (text or json)
  
- `process` - Process data or files
  - `input` - Input data or file path (optional)
  - `-o, --output` - Output file path (optional)

### Global Options

- `-h, --help` - Show help message
- `--version` - Show version number
- `-v, --verbose` - Enable verbose output

## Examples

```bash
# Basic usage
./ohmega info

# Processing with output
./ohmega process "Hello, World!" -o greeting.txt

# Verbose processing
./ohmega -v process "Important data" -o important.txt
```

## Requirements

- Python 3.6 or higher

## License

This project is part of the EU-UNION-AI-PACT initiative.
