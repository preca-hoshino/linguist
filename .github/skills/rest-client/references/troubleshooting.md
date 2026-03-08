# Troubleshooting

## Common Issues

### Request Not Sending

**Problem**: Request doesn't execute when clicking "Send Request"

**Solution**: Ensure file is in HTTP language mode
- Change language mode to "HTTP" (bottom right corner)
- Or use `.http` or `.rest` file extension

### Variables Not Resolving

**Problem**: Variables like `{{variable}}` show as literal text instead of being replaced

**Solution**: Check variable syntax and scope
- Verify variable name matches exactly (case-sensitive)
- For environment variables, confirm you've switched to the right environment
- For file variables, ensure they're defined before the request
- For request variables, ensure the referenced request has `@name` defined

### Authentication Failing

**Problem**: 401/403 responses despite correct credentials

**Solution**: Verify credentials and token expiration
- Check token expiration in variables
- Confirm Base64 encoding for Basic Auth
- Verify API key format in authorization header
- Test with curl command manually to rule out client issues

### Large Responses Slow

**Problem**: Responses take long to display or editor becomes unresponsive

**Solution**: Adjust large response handling
- Check `rest-client.largeResponseBodySizeLimitInMB` setting
- Save response to file instead of previewing
- Reduce response size by using query filters or pagination

### Proxy Issues

**Problem**: Request fails with proxy errors

**Solution**: Configure VS Code proxy settings
- In VS Code settings, search for "proxy"
- Set `http.proxy` and `https.proxy` if behind corporate proxy
- Restart VS Code after changing proxy settings

## Debug Tips

1. **Check REST output panel** for detailed logs
   - View → Output, select "REST Client" from dropdown
   
2. **Hover over variables** to see resolved values
   - Hover preview shows the final value
   
3. **Use request history** to compare working/failing requests
   - `Ctrl+Alt+H` / `Cmd+Alt+H`
   - Identify differences between successful and failed requests
   
4. **Check file language mode**
   - Must be "HTTP" for requests to work
   - Bottom right corner shows current language mode
   
5. **Test with simpler requests first**
   - Start with basic GET request to known API
   - Gradually add complexity (headers, body, auth)
   
6. **Validate JSON/XML** in request body
   - Use online validators if requests fail silently
   - Check Content-Type header matches body format

## File Language Support

### Automatic Recognition

Files with `.http` or `.rest` extension automatically get HTTP language support

### Manual Activation

- Click language selector (bottom right)
- Select "HTTP"

### Features Enabled

When HTTP language is active:
- Syntax highlighting for requests and responses
- Auto-completion for methods, URLs, headers
- Comment support (lines starting with `#` or `//`)
- CodeLens with actionable links
- Fold/Unfold for request blocks
